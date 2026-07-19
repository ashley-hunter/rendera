/**
 * Minimal WebGPU renderer — device + colour-correct present, now drawing a
 * render list of quads (ADR 0002/0003).
 *
 * The scene is composited in a linear-light `rgba16float` target: the target is
 * cleared to a background colour, the render list's quads are drawn instanced
 * (premultiplied `over`), and a present pass encodes the target to the display
 * (sRGB transfer, shared by Display-P3) with optional dither. Geometry comes
 * from `@rendera/core`'s pure render list; this backend just uploads and draws
 * it. Tiling, real fills, and blend modes are later slices.
 */

import type { ImageDrawItem, RenderItem } from '@rendera/core';
import { blueNoiseTile, BLUE_NOISE_SIZE } from './blue-noise';

/** A decoded image source the renderer can upload (browser image types). */
export type ImageSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

/** GPU resources for the textured-image and mip-generation pipelines. */
interface ImageResources {
  pipeline: GPURenderPipeline;
  texLayout: GPUBindGroupLayout;
  sampler: GPUSampler;
  mipPipeline: GPURenderPipeline;
  mipLayout: GPUBindGroupLayout;
  mipSampler: GPUSampler;
}

interface CachedImage {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
}

export interface RendererColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface WebGpuRendererOptions {
  colorSpace?: PredefinedColorSpace;
  dither?: boolean;
  /**
   * Supersampling factor: the scene is rendered into a target this many times
   * larger than the display in each axis, then box-filtered down at present for
   * anti-aliased edges. Default 2 (4 samples/px). Clamped down only if the
   * target would exceed the device's `maxTextureDimension2D`.
   */
  supersample?: number;
}

export interface ReadbackResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  format: GPUTextureFormat;
  bytesPerRow: number;
}

const QUAD_SHADER = /* wgsl */ `
struct Viewport { size : vec2f, _pad : vec2f };
@group(0) @binding(0) var<uniform> vp : Viewport;

struct VOut { @builtin(position) pos : vec4f, @location(0) color : vec4f };

@vertex fn vs(
  @location(0) corner : vec2f,
  @location(1) m0 : vec2f,
  @location(2) m1 : vec2f,
  @location(3) m2 : vec2f,
  @location(4) color : vec4f
) -> VOut {
  let screen = m0 * corner.x + m1 * corner.y + m2;
  let clip = vec2f(screen.x / vp.size.x * 2.0 - 1.0, 1.0 - screen.y / vp.size.y * 2.0);
  var out : VOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment fn fs(@location(0) color : vec4f) -> @location(0) vec4f {
  return vec4f(color.rgb * color.a, color.a); // premultiplied linear
}
`;

const PRESENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var sceneTex : texture_2d<f32>;
struct Params { dither : f32, scale : f32, _p1 : f32, _p2 : f32 };
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var noiseTex : texture_2d<f32>; // 64x64 blue-noise tile

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[i], 0.0, 1.0);
}

fn linear_to_srgb(c : f32) -> f32 {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
  return select(hi, lo, c <= 0.0031308);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  // Box-filter the supersampled scene down to this display pixel. The scene is
  // linear-light premultiplied, so a plain average is the correct resolve;
  // the sRGB encode and dither happen once, afterwards.
  let s = max(1, i32(params.scale));
  let base = vec2i(frag.xy) * s;
  var acc = vec4f(0.0);
  for (var dy = 0; dy < s; dy = dy + 1) {
    for (var dx = 0; dx < s; dx = dx + 1) {
      acc = acc + textureLoad(sceneTex, base + vec2i(dx, dy), 0);
    }
  }
  let lin = acc / f32(s * s);
  var rgb = vec3f(linear_to_srgb(lin.r), linear_to_srgb(lin.g), linear_to_srgb(lin.b));
  // Blue-noise ordered dither (tile wraps every 64 display px), applied once in
  // the display domain so 8-bit quantization does not band smooth gradients.
  let noise = textureLoad(noiseTex, vec2i(frag.xy) % vec2i(64, 64), 0).r;
  rgb = rgb + vec3f((noise - 0.5) / 255.0 * params.dither);
  return vec4f(rgb, lin.a);
}
`;

// Textured-quad pipeline. Samples an sRGB-view texture (hardware decodes to
// linear), so mip generation and filtering all happen in linear light. Output
// is premultiplied linear for the `over` blend into the scene target.
const IMAGE_SHADER = /* wgsl */ `
struct Viewport { size : vec2f, _pad : vec2f };
@group(0) @binding(0) var<uniform> vp : Viewport;
@group(1) @binding(0) var tex : texture_2d<f32>;
@group(1) @binding(1) var samp : sampler;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) opacity : f32,
};

@vertex fn vs(
  @location(0) corner : vec2f,
  @location(1) m0 : vec2f,
  @location(2) m1 : vec2f,
  @location(3) m2 : vec2f,
  @location(4) opacity : f32
) -> VOut {
  let screen = m0 * corner.x + m1 * corner.y + m2;
  let clip = vec2f(screen.x / vp.size.x * 2.0 - 1.0, 1.0 - screen.y / vp.size.y * 2.0);
  var out : VOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.uv = corner;
  out.opacity = opacity;
  return out;
}

// Catmull-Rom cubic weights for a fractional offset in [0,1].
fn cubic(t : f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return 0.5 * vec4f(
    -t3 + 2.0 * t2 - t,
    3.0 * t3 - 5.0 * t2 + 2.0,
    -3.0 * t3 + 4.0 * t2 + t,
    t3 - t2
  );
}

// Bicubic (Catmull-Rom) magnification: 16 taps around the sample point, giving
// smooth-yet-sharp upscaling instead of blocky bilinear. Used when magnifying;
// minification falls through to the hardware sampler's mip/anisotropic path.
fn sampleBicubic(uv : vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(tex, 0));
  let coord = uv * dims - 0.5;
  let f = fract(coord);
  let base = floor(coord);
  let wx = cubic(f.x);
  let wy = cubic(f.y);
  var acc = vec4f(0.0);
  for (var j = 0; j < 4; j = j + 1) {
    var row = vec4f(0.0);
    for (var i = 0; i < 4; i = i + 1) {
      let p = (base + vec2f(f32(i) - 1.0, f32(j) - 1.0) + 0.5) / dims;
      row = row + textureSampleLevel(tex, samp, p, 0.0) * wx[i];
    }
    acc = acc + row * wy[j];
  }
  return acc;
}

@fragment fn fs(@location(0) uv : vec2f, @location(1) opacity : f32) -> @location(0) vec4f {
  // Both samples are computed in uniform control flow (textureSample needs
  // implicit derivatives), then selected by the screen-space texel footprint:
  // < 1 texel/pixel means magnifying -> bicubic; otherwise the hardware
  // trilinear + anisotropic sample handles minification cleanly.
  let dims = vec2f(textureDimensions(tex, 0));
  let footprint = max(length(dpdx(uv * dims)), length(dpdy(uv * dims)));
  let hw = textureSample(tex, samp, uv);
  let bicubic = sampleBicubic(uv);
  let c = select(hw, bicubic, footprint < 1.0);
  let a = clamp(c.a, 0.0, 1.0) * opacity;
  return vec4f(c.rgb * a, a); // premultiplied linear
}
`;

// Mip-generation blit: box-downsample the previous level with a linear sampler.
// Both views are sRGB, so the average is computed in linear light.
const MIP_SHADER = /* wgsl */ `
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;

struct VOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f };

@vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  out.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return out;
}

@fragment fn fs(@location(0) uv : vec2f) -> @location(0) vec4f {
  return textureSample(src, samp, uv);
}
`;

const SCENE_FORMAT: GPUTextureFormat = 'rgba16float';
const IMAGE_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

export class WebGpuRenderer {
  private background: RendererColor = { r: 0, g: 0, b: 0, a: 1 };
  private width: number;
  private height: number;
  /** Requested supersample factor; the effective one may be clamped by limits. */
  private readonly supersample: number;
  /** Effective (clamped) supersample factor actually in use. */
  private sampleScale = 1;
  private ditherEnabled = false;
  private sceneTarget: GPUTexture;
  private presentBindGroup: GPUBindGroup;

  private instanceBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  private instanceCount = 0;

  private readonly imageCache = new Map<string, CachedImage>();
  private imageInstanceBuffer: GPUBuffer | null = null;
  private imageInstanceCapacity = 0;
  private imageDraws: readonly ImageDrawItem[] = [];

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext | null,
    readonly format: GPUTextureFormat,
    readonly colorSpace: PredefinedColorSpace,
    private readonly presentPipeline: GPURenderPipeline,
    private readonly presentLayout: GPUBindGroupLayout,
    private readonly paramsBuffer: GPUBuffer,
    private readonly quadPipeline: GPURenderPipeline,
    private readonly quadBindGroup: GPUBindGroup,
    private readonly viewportBuffer: GPUBuffer,
    private readonly unitQuadBuffer: GPUBuffer,
    private readonly noiseTexture: GPUTexture,
    private readonly image: ImageResources,
    width: number,
    height: number,
    supersample: number
  ) {
    this.width = width;
    this.height = height;
    this.supersample = Math.max(1, Math.floor(supersample));
    this.sceneTarget = this.createSceneTarget();
    this.presentBindGroup = this.createPresentBindGroup();
    this.updateViewport();
    this.writeParams();
  }

  /** The effective supersample factor in use (may be clamped below the request). */
  get scale(): number {
    return this.sampleScale;
  }

  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options: WebGpuRendererOptions = {}
  ): Promise<WebGpuRenderer> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      throw new Error('WebGPU is not available in this environment');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter available');
    }
    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();
    const colorSpace = options.colorSpace ?? 'display-p3';

    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (context) {
      context.configure({
        device,
        format,
        alphaMode: 'premultiplied',
        colorSpace,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    // --- present pipeline (scene -> display) ---
    const presentModule = device.createShaderModule({ code: PRESENT_SHADER });
    const presentLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const presentPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [presentLayout] }),
      vertex: { module: presentModule, entryPoint: 'vs' },
      fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // --- quad pipeline (render list -> linear scene target) ---
    const quadModule = device.createShaderModule({ code: QUAD_SHADER });
    const quadLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const quadPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [quadLayout] }),
      vertex: {
        module: quadModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: 40,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x2' },
              { shaderLocation: 2, offset: 8, format: 'float32x2' },
              { shaderLocation: 3, offset: 16, format: 'float32x2' },
              { shaderLocation: 4, offset: 24, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module: quadModule,
        entryPoint: 'fs',
        targets: [
          {
            format: SCENE_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    const viewportBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const quadBindGroup = device.createBindGroup({
      layout: quadLayout,
      entries: [{ binding: 0, resource: { buffer: viewportBuffer } }],
    });
    // Unit square as a triangle-strip: (0,0),(1,0),(0,1),(1,1).
    const unitQuadBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(unitQuadBuffer, 0, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));

    // Blue-noise dither tile (uploaded once; wrapped in the shader).
    const noiseTexture = device.createTexture({
      size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: noiseTexture },
      blueNoiseTile(),
      { bytesPerRow: BLUE_NOISE_SIZE, rowsPerImage: BLUE_NOISE_SIZE },
      [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE]
    );

    // --- image pipeline (textured quads -> linear scene target) ---
    const imageModule = device.createShaderModule({ code: IMAGE_SHADER });
    const imageTexLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const imagePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [quadLayout, imageTexLayout] }),
      vertex: {
        module: imageModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: 32,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x2' },
              { shaderLocation: 2, offset: 8, format: 'float32x2' },
              { shaderLocation: 3, offset: 16, format: 'float32x2' },
              { shaderLocation: 4, offset: 24, format: 'float32' },
            ],
          },
        ],
      },
      fragment: {
        module: imageModule,
        entryPoint: 'fs',
        targets: [
          {
            format: SCENE_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    // Trilinear + anisotropic for clean minification; linear magnify (the shader
    // upgrades magnification to bicubic itself).
    const imageSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 16,
    });

    // --- mip generation (linear box-downsample per level) ---
    const mipModule = device.createShaderModule({ code: MIP_SHADER });
    const mipLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const mipPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [mipLayout] }),
      vertex: { module: mipModule, entryPoint: 'vs' },
      fragment: { module: mipModule, entryPoint: 'fs', targets: [{ format: IMAGE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    const mipSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const imageResources: ImageResources = {
      pipeline: imagePipeline,
      texLayout: imageTexLayout,
      sampler: imageSampler,
      mipPipeline,
      mipLayout,
      mipSampler,
    };

    const width = Math.max(1, canvas.width || 1);
    const height = Math.max(1, canvas.height || 1);

    const renderer = new WebGpuRenderer(
      device,
      context,
      format,
      colorSpace,
      presentPipeline,
      presentLayout,
      paramsBuffer,
      quadPipeline,
      quadBindGroup,
      viewportBuffer,
      unitQuadBuffer,
      noiseTexture,
      imageResources,
      width,
      height,
      options.supersample ?? 2
    );
    renderer.setDither(options.dither ?? true);
    return renderer;
  }

  /**
   * Decode+upload an image under `assetId`, building a full mip chain in linear
   * light. Idempotent per id: a re-register replaces the previous texture. The
   * matching `ImageNode`/render-list `assetId` then resolves to this texture.
   */
  registerImage(assetId: string, source: ImageSource): void {
    const width = source.width;
    const height = source.height;
    if (width < 1 || height < 1) {
      throw new Error(`image "${assetId}" has zero size`);
    }
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const texture = this.device.createTexture({
      size: [width, height],
      format: IMAGE_FORMAT,
      mipLevelCount,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source },
      { texture, mipLevel: 0 },
      [width, height]
    );
    this.generateMips(texture, mipLevelCount);

    const bindGroup = this.device.createBindGroup({
      layout: this.image.texLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.image.sampler },
      ],
    });
    this.imageCache.get(assetId)?.texture.destroy();
    this.imageCache.set(assetId, { texture, bindGroup });
  }

  /** Whether an image asset has been registered. */
  hasImage(assetId: string): boolean {
    return this.imageCache.has(assetId);
  }

  /** Drop a registered image and free its texture. */
  disposeImage(assetId: string): void {
    this.imageCache.get(assetId)?.texture.destroy();
    this.imageCache.delete(assetId);
  }

  /** Fill levels 1..n by repeatedly box-downsampling the previous level. */
  private generateMips(texture: GPUTexture, levels: number): void {
    const encoder = this.device.createCommandEncoder();
    for (let level = 1; level < levels; level++) {
      const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const bindGroup = this.device.createBindGroup({
        layout: this.image.mipLayout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.image.mipSampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      pass.setPipeline(this.image.mipPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /** Set the linear-light background colour of the scene. */
  setClearColor(color: RendererColor): void {
    this.background = color;
  }

  setDither(enabled: boolean): void {
    this.ditherEnabled = enabled;
    this.writeParams();
  }

  /** Upload the draw list: solid quads (instanced) and textured image quads. */
  setRenderList(items: readonly RenderItem[]): void {
    const solids = items.filter((i): i is Extract<RenderItem, { kind: 'solid' }> => i.kind === 'solid');
    this.imageDraws = items.filter((i): i is ImageDrawItem => i.kind === 'image');

    this.instanceCount = solids.length;
    if (solids.length > 0) {
      const data = new Float32Array(solids.length * 10);
      solids.forEach((item, i) => {
        const o = i * 10;
        const m = item.transform;
        data[o] = m.a;
        data[o + 1] = m.b;
        data[o + 2] = m.c;
        data[o + 3] = m.d;
        data[o + 4] = m.e;
        data[o + 5] = m.f;
        data[o + 6] = item.color.r;
        data[o + 7] = item.color.g;
        data[o + 8] = item.color.b;
        data[o + 9] = item.color.a;
      });
      this.instanceBuffer = this.ensureBuffer(this.instanceBuffer, data.byteLength, 'instance');
      this.instanceCapacity = Math.max(this.instanceCapacity, data.byteLength);
      this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    }

    // Image instance data: transform (m0,m1,m2) + opacity, 8 floats (32 bytes).
    if (this.imageDraws.length > 0) {
      const data = new Float32Array(this.imageDraws.length * 8);
      this.imageDraws.forEach((item, i) => {
        const o = i * 8;
        const m = item.transform;
        data[o] = m.a;
        data[o + 1] = m.b;
        data[o + 2] = m.c;
        data[o + 3] = m.d;
        data[o + 4] = m.e;
        data[o + 5] = m.f;
        data[o + 6] = item.opacity;
        data[o + 7] = 0;
      });
      this.imageInstanceBuffer = this.ensureBuffer(
        this.imageInstanceBuffer,
        data.byteLength,
        'image-instance'
      );
      this.imageInstanceCapacity = Math.max(this.imageInstanceCapacity, data.byteLength);
      this.device.queue.writeBuffer(this.imageInstanceBuffer, 0, data);
    }
  }

  /** Grow a vertex buffer if needed, returning one at least `byteLength` big. */
  private ensureBuffer(existing: GPUBuffer | null, byteLength: number, label: string): GPUBuffer {
    if (existing && existing.size >= byteLength) {
      return existing;
    }
    existing?.destroy();
    return this.device.createBuffer({
      label,
      size: byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sceneTarget.destroy();
    this.sceneTarget = this.createSceneTarget();
    this.presentBindGroup = this.createPresentBindGroup();
    this.updateViewport();
    this.writeParams();
  }

  render(): void {
    if (!this.context) {
      throw new Error('renderer has no canvas context');
    }
    const encoder = this.device.createCommandEncoder();
    this.encode(encoder, this.context.getCurrentTexture().createView());
    this.device.queue.submit([encoder.finish()]);
  }

  async readback(): Promise<ReadbackResult> {
    const bytesPerRow = Math.ceil((this.width * 4) / 256) * 256;
    const output = this.device.createTexture({
      size: [this.width, this.height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const buffer = this.device.createBuffer({
      size: bytesPerRow * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = this.device.createCommandEncoder();
    this.encode(encoder, output.createView());
    encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow }, [this.width, this.height]);
    this.device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8ClampedArray(buffer.getMappedRange().slice(0));
    buffer.unmap();
    output.destroy();
    buffer.destroy();

    return { data, width: this.width, height: this.height, format: this.format, bytesPerRow };
  }

  destroy(): void {
    this.sceneTarget.destroy();
    this.paramsBuffer.destroy();
    this.viewportBuffer.destroy();
    this.unitQuadBuffer.destroy();
    this.noiseTexture.destroy();
    this.instanceBuffer?.destroy();
    this.imageInstanceBuffer?.destroy();
    for (const { texture } of this.imageCache.values()) {
      texture.destroy();
    }
    this.imageCache.clear();
  }

  private encode(encoder: GPUCommandEncoder, targetView: GPUTextureView): void {
    // Scene pass: clear to background, draw the quads (premultiplied over).
    const scenePass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.sceneTarget.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: this.background,
        },
      ],
    });
    if (this.instanceCount > 0 && this.instanceBuffer) {
      scenePass.setPipeline(this.quadPipeline);
      scenePass.setBindGroup(0, this.quadBindGroup);
      scenePass.setVertexBuffer(0, this.unitQuadBuffer);
      scenePass.setVertexBuffer(1, this.instanceBuffer);
      scenePass.draw(4, this.instanceCount);
    }
    // Image quads: one draw per image (its own texture), selecting its instance
    // slot via firstInstance. Skips assets that are not yet registered.
    if (this.imageDraws.length > 0 && this.imageInstanceBuffer) {
      scenePass.setPipeline(this.image.pipeline);
      scenePass.setBindGroup(0, this.quadBindGroup);
      scenePass.setVertexBuffer(0, this.unitQuadBuffer);
      scenePass.setVertexBuffer(1, this.imageInstanceBuffer);
      this.imageDraws.forEach((item, i) => {
        const cached = this.imageCache.get(item.assetId);
        if (!cached) {
          return;
        }
        scenePass.setBindGroup(1, cached.bindGroup);
        scenePass.draw(4, 1, 0, i);
      });
    }
    scenePass.end();

    // Present pass: encode linear scene -> display.
    const present = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    present.setPipeline(this.presentPipeline);
    present.setBindGroup(0, this.presentBindGroup);
    present.draw(3);
    present.end();
  }

  private updateViewport(): void {
    // Viewport stays at *display* resolution: clip space is resolution-
    // independent, so the render list rasterizes into the larger (supersampled)
    // scene target at higher density without any change to its coordinates.
    this.device.queue.writeBuffer(
      this.viewportBuffer,
      0,
      new Float32Array([this.width, this.height, 0, 0])
    );
  }

  private writeParams(): void {
    this.device.queue.writeBuffer(
      this.paramsBuffer,
      0,
      new Float32Array([this.ditherEnabled ? 1 : 0, this.sampleScale, 0, 0])
    );
  }

  /** The supersample factor that fits within the device's texture-size limit. */
  private computeScale(): number {
    const max = this.device.limits.maxTextureDimension2D;
    let scale = this.supersample;
    while (scale > 1 && (this.width * scale > max || this.height * scale > max)) {
      scale -= 1;
    }
    return scale;
  }

  private createSceneTarget(): GPUTexture {
    this.sampleScale = this.computeScale();
    return this.device.createTexture({
      size: [this.width * this.sampleScale, this.height * this.sampleScale],
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private createPresentBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.presentLayout,
      entries: [
        { binding: 0, resource: this.sceneTarget.createView() },
        { binding: 1, resource: { buffer: this.paramsBuffer } },
        { binding: 2, resource: this.noiseTexture.createView() },
      ],
    });
  }
}
