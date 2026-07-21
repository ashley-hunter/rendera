import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  buildRenderList,
  createCamera,
  EMPTY_SELECTION,
  exportSvg,
  fitBounds,
  hitTest,
  layoutTextNode,
  layoutTextNodeGlyphs,
  MsdfAtlas,
  panBy,
  RenderaFont,
  resolveSelectionClick,
  screenToWorld,
  selectionBounds,
  vec2,
  ViewportGesture,
  withPixelRatio,
  worldToScreen,
  zoomAround,
  type Camera,
  type MsdfNodeLayout,
  type NodeId,
  type Path,
  type SceneDocument,
  type Selection,
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
  /** Click to select the top-most shape and draw its bounding box (default off). */
  readonly selectable = input(false);
  /** Show SVG / PNG export buttons in the toolbar (default off). */
  readonly exportable = input(false);

  /** The current selection (ids + primary); drives the on-screen bounding box. */
  protected readonly selection = signal<Selection>(EMPTY_SELECTION);
  private pointerMoved = false;

  /** The selection frame in CSS px over the stage, or null when nothing is
   *  selected. Recomputes as the camera or selection changes. */
  protected readonly selectionBox = computed(() => {
    const sel = this.selection();
    if (sel.ids.size === 0) return null;
    const b = selectionBounds(this.document, sel.ids);
    if (!b) return null;
    const cam = this.camera();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of [vec2(b.minX, b.minY), vec2(b.maxX, b.minY), vec2(b.minX, b.maxY), vec2(b.maxX, b.maxY)]) {
      const p = worldToScreen(cam, c);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  });

  private document: SceneDocument = createSampleDocument();
  /** Shaped, local-space glyph outlines per text node (async; empty until ready). */
  private textPaths: ReadonlyMap<NodeId, Path> = new Map();
  /** Pre-baked MSDF layouts per (small) text node. */
  private textMsdf: ReadonlyMap<NodeId, MsdfNodeLayout> = new Map();
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

  /** Text at/under this authoring em size (px) is prepared for MSDF; larger uses
   * the analytic outline only. */
  private static readonly MSDF_MAX_PX = 48;
  /** Em size the MSDF atlas bakes glyphs at (px). */
  private static readonly MSDF_ATLAS_EM = 48;

  /**
   * Load the scene's fonts and prepare its text nodes for drawing. Small/plain
   * text routes to the MSDF atlas (cheap, cached); large or stroked text uses
   * the analytic outline fill (perfect at any size). Runs once before the first
   * draw; fills each node's `size` so world bounds (and fit) work.
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
    // One shared atlas (the showcase uses a single font); grows as glyphs bake.
    let atlas: MsdfAtlas | undefined;
    const msdfNodes: { id: NodeId; glyphs: { originX: number; originY: number; glyphId: number }[]; fontSize: number }[] = [];

    for (const node of this.document) {
      if (node.type !== 'text') {
        continue;
      }
      const text = node as TextNode;
      const font = fonts.get(text.fontId);
      if (!font) {
        continue;
      }
      const useMsdf = text.fontSize <= WebGpuScene.MSDF_MAX_PX && !text.stroke;
      // Always prepare the analytic outline: it's the fallback when an MSDF node
      // is magnified past its atlas resolution (avoids MSDF's blow-up artifacts),
      // and the only representation for large/stroked text.
      const layout = layoutTextNode(font, text);
      paths.set(node.id, layout.path);
      if (!text.size) {
        this.document.update(node.id, { size: vec2(layout.width, layout.height) });
      }
      if (useMsdf) {
        atlas ??= new MsdfAtlas(font, { emPx: WebGpuScene.MSDF_ATLAS_EM, pxRange: 4 });
        const laid = layoutTextNodeGlyphs(font, text);
        for (const g of laid.glyphs) {
          atlas.glyph(g.glyphId); // bake now (may grow the atlas)
        }
        msdfNodes.push({
          id: node.id,
          glyphs: laid.glyphs.map((g) => ({ originX: g.originX, originY: g.originY, glyphId: g.glyphId })),
          fontSize: text.fontSize,
        });
      }
    }
    this.textPaths = paths;

    // The atlas is fully baked/grown now; capture final dims + stable cells and
    // upload once.
    if (atlas) {
      const tex = atlas.texture;
      this.renderer?.setMsdfAtlas(tex.data, tex.width, tex.height);
      const msdf = new Map<NodeId, MsdfNodeLayout>();
      for (const n of msdfNodes) {
        const glyphs = n.glyphs
          .map((g) => ({ originX: g.originX, originY: g.originY, cell: atlas!.glyph(g.glyphId) }))
          .filter((g): g is { originX: number; originY: number; cell: NonNullable<typeof g.cell> } => g.cell !== null);
        msdf.set(n.id, {
          glyphs,
          fontSize: n.fontSize,
          atlasWidth: tex.width,
          atlasHeight: tex.height,
          pxRange: atlas.pxRange,
          atlasEmPx: atlas.emPx,
        });
      }
      this.textMsdf = msdf;
    }
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
    this.pointerMoved = false;
    this.gesture.down(event.pointerId, this.toCanvas(event, canvas));
  }

  protected onPointerMove(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    const change = this.gesture.move(event.pointerId, this.toCanvas(event, canvas));
    if (change) {
      this.pointerMoved = true;
      this.beginInteraction();
      this.applyGesture(change);
    }
  }

  protected onPointerUp(event: PointerEvent): void {
    this.gesture.up(event.pointerId);
    // A click (no drag) selects the top-most shape; empty space clears; shift
    // adds/removes. Drag is reserved for panning.
    const canvas = this.canvasRef()?.nativeElement;
    if (this.selectable() && !this.pointerMoved && canvas) {
      const world = screenToWorld(this.camera(), this.toCanvas(event, canvas));
      const hit = hitTest(this.document, world, { tolerance: 6 / this.camera().zoom, select: 'outermost' });
      this.selection.update((s) => resolveSelectionClick(s, hit, { additive: event.shiftKey }));
    }
    this.pointerMoved = false;
  }

  /** Download the scene as an SVG file (vector, re-importable). */
  protected exportSvgFile(): void {
    this.download('scene.svg', new Blob([exportSvg(this.document)], { type: 'image/svg+xml' }));
  }

  /** Download the current frame as a PNG file. */
  protected async exportPngFile(): Promise<void> {
    if (!this.renderer) return;
    const bytes = await this.renderer.toPng();
    this.download('scene.png', new Blob([bytes as BlobPart], { type: 'image/png' }));
  }

  private download(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = globalThis.document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
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
      buildRenderList(this.document, camera, { textPaths: this.textPaths, textMsdf: this.textMsdf })
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
