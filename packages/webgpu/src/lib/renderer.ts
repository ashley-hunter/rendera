/**
 * Minimal WebGPU renderer — the first slice of the backend (ADR 0002/0003).
 *
 * It proves the load-bearing colour pipeline: a linear-light `rgba16float`
 * scene target is cleared to a linear colour, then a present pass encodes it to
 * the display (sRGB transfer function, shared by Display-P3) with optional
 * blue-noise-style dither, writing to a Display-P3 (or sRGB) canvas. Geometry,
 * a real compositor, tiling, and blend modes come in later slices.
 */

export interface RendererColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface WebGpuRendererOptions {
  /** Output colour space; falls back is the caller's concern. */
  colorSpace?: PredefinedColorSpace;
  /** Whether to apply output dither (default true; disable for exact tests). */
  dither?: boolean;
}

export interface ReadbackResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  format: GPUTextureFormat;
  bytesPerRow: number;
}

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

export class WebGpuRenderer {
  private clearColor: RendererColor = { r: 0, g: 0, b: 0, a: 1 };
  private width: number;
  private height: number;
  private sceneTarget: GPUTexture;
  private bindGroup: GPUBindGroup;

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext | null,
    readonly format: GPUTextureFormat,
    readonly colorSpace: PredefinedColorSpace,
    private readonly pipeline: GPURenderPipeline,
    private readonly bindGroupLayout: GPUBindGroupLayout,
    private readonly paramsBuffer: GPUBuffer,
    width: number,
    height: number
  ) {
    this.width = width;
    this.height = height;
    this.sceneTarget = this.createSceneTarget();
    this.bindGroup = this.createBindGroup();
  }

  /** Acquire a device and build the renderer for a canvas (or offscreen). */
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

    const module = device.createShaderModule({ code: PRESENT_SHADER });
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    const paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const width = Math.max(1, canvas.width || 1);
    const height = Math.max(1, canvas.height || 1);

    const renderer = new WebGpuRenderer(
      device,
      context,
      format,
      colorSpace,
      pipeline,
      bindGroupLayout,
      paramsBuffer,
      width,
      height
    );
    renderer.setDither(options.dither ?? true);
    return renderer;
  }

  /** Set the linear-light clear colour of the scene target. */
  setClearColor(color: RendererColor): void {
    this.clearColor = color;
  }

  /** Enable/disable output dither. */
  setDither(enabled: boolean): void {
    this.device.queue.writeBuffer(
      this.paramsBuffer,
      0,
      new Float32Array([enabled ? 1 : 0, 0, 0, 0])
    );
  }

  /** Resize the scene target (device pixels). */
  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sceneTarget.destroy();
    this.sceneTarget = this.createSceneTarget();
    this.bindGroup = this.createBindGroup();
  }

  /** Render to the configured canvas. */
  render(): void {
    if (!this.context) {
      throw new Error('renderer has no canvas context');
    }
    const encoder = this.device.createCommandEncoder();
    this.encode(encoder, this.context.getCurrentTexture().createView());
    this.device.queue.submit([encoder.finish()]);
  }

  /** Render to an offscreen texture and read the encoded pixels back (tests). */
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
    encoder.copyTextureToBuffer(
      { texture: output },
      { buffer, bytesPerRow },
      [this.width, this.height]
    );
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
  }

  private encode(encoder: GPUCommandEncoder, targetView: GPUTextureView): void {
    // Clear the linear scene target.
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: this.sceneTarget.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: this.clearColor,
          },
        ],
      })
      .end();

    // Present: encode linear -> display into the target.
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
  }

  private createSceneTarget(): GPUTexture {
    return this.device.createTexture({
      size: [this.width, this.height],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private createBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.sceneTarget.createView() },
        { binding: 1, resource: { buffer: this.paramsBuffer } },
      ],
    });
  }
}
