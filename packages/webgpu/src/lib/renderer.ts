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

import type { QuadDrawItem } from '@rendera/core';

export interface RendererColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface WebGpuRendererOptions {
  colorSpace?: PredefinedColorSpace;
  dither?: boolean;
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
struct Params { dither : f32, _p0 : f32, _p1 : f32, _p2 : f32 };
@group(0) @binding(1) var<uniform> params : Params;

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[i], 0.0, 1.0);
}

fn linear_to_srgb(c : f32) -> f32 {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
  return select(hi, lo, c <= 0.0031308);
}

fn hash(p : vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let coord = vec2i(frag.xy);
  let lin = textureLoad(sceneTex, coord, 0);
  var rgb = vec3f(linear_to_srgb(lin.r), linear_to_srgb(lin.g), linear_to_srgb(lin.b));
  let d = (hash(frag.xy) - 0.5) / 255.0 * params.dither;
  rgb = rgb + vec3f(d);
  return vec4f(rgb, lin.a);
}
`;

const SCENE_FORMAT: GPUTextureFormat = 'rgba16float';

export class WebGpuRenderer {
  private background: RendererColor = { r: 0, g: 0, b: 0, a: 1 };
  private width: number;
  private height: number;
  private sceneTarget: GPUTexture;
  private presentBindGroup: GPUBindGroup;

  private instanceBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  private instanceCount = 0;

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
    width: number,
    height: number
  ) {
    this.width = width;
    this.height = height;
    this.sceneTarget = this.createSceneTarget();
    this.presentBindGroup = this.createPresentBindGroup();
    this.updateViewport();
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
      width,
      height
    );
    renderer.setDither(options.dither ?? true);
    return renderer;
  }

  /** Set the linear-light background colour of the scene. */
  setClearColor(color: RendererColor): void {
    this.background = color;
  }

  setDither(enabled: boolean): void {
    this.device.queue.writeBuffer(
      this.paramsBuffer,
      0,
      new Float32Array([enabled ? 1 : 0, 0, 0, 0])
    );
  }

  /** Upload the quads to draw (screen-space transform + linear colour each). */
  setRenderList(items: readonly QuadDrawItem[]): void {
    this.instanceCount = items.length;
    if (items.length === 0) {
      return;
    }
    const data = new Float32Array(items.length * 10);
    items.forEach((item, i) => {
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
    if (!this.instanceBuffer || this.instanceCapacity < data.byteLength) {
      this.instanceBuffer?.destroy();
      this.instanceBuffer = this.device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.instanceCapacity = data.byteLength;
    }
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sceneTarget.destroy();
    this.sceneTarget = this.createSceneTarget();
    this.presentBindGroup = this.createPresentBindGroup();
    this.updateViewport();
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
    this.instanceBuffer?.destroy();
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
    this.device.queue.writeBuffer(
      this.viewportBuffer,
      0,
      new Float32Array([this.width, this.height, 0, 0])
    );
  }

  private createSceneTarget(): GPUTexture {
    return this.device.createTexture({
      size: [this.width, this.height],
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
      ],
    });
  }
}
