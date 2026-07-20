import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  buildRenderList,
  createCamera,
  fitBounds,
  layoutTextNode,
  panBy,
  RenderaFont,
  vec2,
  ViewportGesture,
  withPixelRatio,
  zoomAround,
  type Camera,
  type NodeId,
  type Path,
  type SceneDocument,
  type TextNode,
  type Vec2,
  type ViewportGestureChange,
} from '@rendera/core';
import { WebGpuRenderer } from '@rendera/webgpu';
import { createSampleDocument } from '../sample-scene';

type Status = 'pending' | 'ready' | 'unsupported';

/** A linear-light clear colour. */
interface ClearColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A font to load for the scene's text nodes: an id plus bytes (or a URL). */
export interface FontSource {
  /** Matches a `TextNode`'s `fontId`. */
  readonly id: string;
  /** Font bytes, or a URL to fetch them from (raw `.ttf`/`.otf`). */
  readonly src: string | ArrayBuffer;
}

/**
 * What to render: a document, an optional initial camera and clear colour, an
 * async `setup` hook that runs once after the device is ready (e.g. to register
 * image assets), and any `fonts` whose glyphs the scene's text nodes need.
 */
export interface SceneSource {
  readonly document: SceneDocument;
  readonly camera?: Camera;
  readonly clearColor?: ClearColor;
  readonly fonts?: readonly FontSource[];
  setup?(renderer: WebGpuRenderer): void | Promise<void>;
}

/**
 * A GPU-rendered showcase via `@rendera/webgpu`, with drag-pan, wheel-zoom, and
 * two-finger pinch. Renders the shared sample document by default, or any
 * `SceneSource` passed via the `scene` input. Device init is async and the
 * component degrades gracefully when WebGPU is unavailable (ADR 0002); the
 * Canvas2D `SceneInspector` remains the always-works debug view.
 */
@Component({
  selector: 'rendera-webgpu-scene',
  imports: [],
  templateUrl: './webgpu-scene.html',
  styleUrl: './webgpu-scene.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebGpuScene {
  private readonly canvasRef =
    viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  /** Optional scene to render; defaults to the shared sample document. */
  readonly scene = input<SceneSource | null>(null);

  private document: SceneDocument = createSampleDocument();
  /** Shaped, local-space glyph outlines per text node (async; empty until ready). */
  private textPaths: ReadonlyMap<NodeId, Path> = new Map();
  private readonly camera = signal<Camera>(createCamera({ pan: vec2(20, 20) }));
  private renderer: WebGpuRenderer | null = null;
  private resizeObserver?: ResizeObserver;
  private readonly gesture = new ViewportGesture();
  private frame = 0;
  private interacting = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private lastFrameTime = 0;

  /** Smoothed frames-per-second of the render loop (0 until the first frames). */
  readonly fps = signal(0);

  /** Device-init state: 'pending' -> 'ready' | 'unsupported'. */
  readonly renderState = signal<Status>('pending');
  protected readonly message = signal('');

  /** Resolves once device init has settled (ready or unsupported). */
  readonly settled: Promise<void>;
  private settle!: () => void;

  constructor() {
    this.settled = new Promise<void>((resolve) => (this.settle = resolve));
    afterNextRender(() => {
      void this.init();
    });
  }

  private async init(): Promise<void> {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      this.fail('No canvas element.');
      return;
    }
    const source = this.scene();
    if (source) {
      this.document = source.document;
      if (source.camera) {
        this.camera.set(source.camera);
      }
    }
    this.sizeCanvas(canvas);
    try {
      this.renderer = await WebGpuRenderer.create(canvas, {
        colorSpace: 'srgb',
        supersample: 2,
      });
      this.renderer.setClearColor(source?.clearColor ?? { r: 0.02, g: 0.02, b: 0.03, a: 1 });
      // Register image assets (etc.) and shape any text before the first draw.
      await source?.setup?.(this.renderer);
      await this.prepareText(source);
      this.renderState.set('ready');
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(canvas);
      }
      // A source without an explicit camera is framed to fit its content.
      if (source && !source.camera) {
        this.fit();
      } else {
        this.draw();
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
    this.settle();
  }

  private fail(message: string): void {
    this.renderState.set('unsupported');
    this.message.set(message);
  }

  /**
   * Load the scene's fonts and shape its text nodes into local-space glyph
   * outlines (HarfBuzz; the wasm loads lazily on first font). Runs once before
   * the first draw. Each shaped node's `size` is filled in so world bounds (and
   * fit-to-content framing) work.
   */
  private async prepareText(source: SceneSource | null): Promise<void> {
    if (!source?.fonts?.length) {
      return;
    }
    const fonts = new Map<string, RenderaFont>();
    for (const font of source.fonts) {
      const data =
        typeof font.src === 'string'
          ? await fetch(font.src).then((r) => r.arrayBuffer())
          : font.src;
      fonts.set(font.id, await RenderaFont.load(data));
    }
    const paths = new Map<NodeId, Path>();
    for (const node of this.document) {
      if (node.type !== 'text') {
        continue;
      }
      const text = node as TextNode;
      const font = fonts.get(text.fontId);
      if (!font) {
        continue;
      }
      const layout = layoutTextNode(font, text);
      paths.set(node.id, layout.path);
      if (!text.size) {
        this.document.update(node.id, { size: vec2(layout.width, layout.height) });
      }
    }
    this.textPaths = paths;
  }

  protected fit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const bounds = this.document.getWorldBounds(this.document.root.id);
    if (!canvas || !bounds) {
      return;
    }
    // The camera is logical, so fit to the CSS (logical) viewport, not the
    // device-pixel backing store.
    const rect = canvas.getBoundingClientRect();
    this.camera.set(fitBounds(bounds, { width: rect.width, height: rect.height }, 24));
    this.draw();
  }

  protected onPointerDown(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // Ignore non-active pointers (e.g. synthetic events).
    }
    this.gesture.down(event.pointerId, this.toCanvas(event, canvas));
  }

  protected onPointerMove(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    const change = this.gesture.move(event.pointerId, this.toCanvas(event, canvas));
    if (change) {
      this.beginInteraction();
      this.applyGesture(change);
    }
  }

  protected onPointerUp(event: PointerEvent): void {
    this.gesture.up(event.pointerId);
  }

  protected onWheel(event: WheelEvent): void {
    event.preventDefault();
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    this.beginInteraction();
    const anchor = this.toCanvas(event, canvas);
    this.camera.update((c) => zoomAround(c, anchor, event.deltaY < 0 ? 1.1 : 1 / 1.1));
    this.draw();
  }

  /**
   * Drop to 1x supersampling while the user pans/zooms (analytic vector AA needs
   * no SSAA, so motion stays crisp), then restore full 2x quality once idle.
   * A ~180ms debounce means the switch happens on interaction start/end, not
   * per frame.
   */
  private beginInteraction(): void {
    if (!this.interacting) {
      this.interacting = true;
      this.renderer?.setSupersample(1);
    }
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.interacting = false;
      this.renderer?.setSupersample(2);
      this.draw();
    }, 180);
  }

  /** Apply a recognizer change (single-finger pan or two-finger pinch) to the camera. */
  private applyGesture(change: ViewportGestureChange): void {
    this.camera.update((c) => {
      const panned = panBy(c, change.pan);
      return change.zoom === 1 ? panned : zoomAround(panned, change.anchor, change.zoom);
    });
    this.draw();
  }

  private toCanvas(event: MouseEvent, canvas: HTMLCanvasElement): Vec2 {
    const rect = canvas.getBoundingClientRect();
    return vec2(event.clientX - rect.left, event.clientY - rect.top);
  }

  private onResize(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.renderer) {
      return;
    }
    this.sizeCanvas(canvas);
    this.renderer.resize(canvas.width, canvas.height);
    this.draw();
  }

  /** Current device-pixel ratio (physical px per CSS px). */
  private pixelRatio(): number {
    return globalThis.devicePixelRatio || 1;
  }

  /**
   * Size the canvas *backing store* to physical device pixels so the GPU
   * rasterizes at full resolution (crisp on HiDPI / mobile). CSS keeps the
   * element at its logical size, so the browser never upscales the render.
   */
  private sizeCanvas(canvas: HTMLCanvasElement): void {
    const dpr = this.pixelRatio();
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  /**
   * Coalesce draw requests into a single render per animation frame. Presenting
   * to a WebGPU canvas must happen inside the frame callback so the swapchain
   * texture is the one the compositor will show (multiple `draw()` calls in one
   * task collapse to one GPU submit).
   */
  private draw(): void {
    if (!this.renderer || this.frame) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.drawNow();
    });
  }

  private drawNow(): void {
    if (!this.renderer) {
      return;
    }
    // Build the render list in device pixels (logical camera scaled by DPR) so
    // geometry lands on the full-resolution backing store.
    const camera = withPixelRatio(this.camera(), this.pixelRatio());
    this.renderer.setRenderList(
      buildRenderList(this.document, camera, { textPaths: this.textPaths })
    );
    this.renderer.render();
    this.recordFrame();
  }

  /** Update the smoothed FPS readout from the interval between rendered frames. */
  private recordFrame(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;
    if (dt > 0 && dt < 500) {
      const instant = 1000 / dt;
      this.fps.update((v) => (v ? Math.round(v * 0.85 + instant * 0.15) : Math.round(instant)));
    }
  }
}
