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
  applyTransform,
  buildRenderList,
  createCamera,
  createSelection,
  deleteNodes,
  dragTransform,
  duplicateNodes,
  EMPTY_SELECTION,
  exportSvg,
  fitBounds,
  handleAt,
  handles,
  History,
  hitTest,
  layoutTextNode,
  layoutTextNodeGlyphs,
  MsdfAtlas,
  nudgeNodes,
  panBy,
  pruneSelection,
  RenderaFont,
  resolveSelectionClick,
  screenToWorld,
  selectionBounds,
  selectionFrame,
  snapMove,
  transformPoint,
  vec2,
  ViewportGesture,
  withPixelRatio,
  worldToScreen,
  zoomAround,
  type Bounds,
  type Camera,
  type HandleId,
  type Mat2D,
  type MsdfNodeLayout,
  type NodeId,
  type Path,
  type SceneDocument,
  type Selection,
  type SnapGuide,
  type SpatialNode,
  type TextNode,
  type Transform,
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

  /** The current selection (ids + primary); drives the on-screen frame. */
  protected readonly selection = signal<Selection>(EMPTY_SELECTION);
  /** Bumped after any transform mutation so the frame overlay recomputes (the
   *  document itself is not a signal). */
  private readonly rev = signal(0);
  private pointerMoved = false;

  // Active handle drag: the grip, the frozen frame + start point (world), and a
  // snapshot of the dragged nodes' transforms (restored each move so the delta is
  // always from the drag start, never compounding).
  private dragHandle: HandleId | null = null;
  private dragBox: Mat2D | null = null;
  private dragStart: Vec2 | null = null;
  private dragSnapshot = new Map<NodeId, Transform>();
  private dragDelta: Mat2D | null = null;
  /** Pre-drag world bounds of the moving selection (for alignment snapping). */
  private dragBounds: Bounds | null = null;
  private history: History | null = null;

  /** Live alignment guides (world space) shown while a move-drag snaps. */
  private readonly snapGuides = signal<readonly SnapGuide[]>([]);

  /** Reactive undo/redo availability (recomputes when `rev` bumps). */
  protected readonly canUndo = computed(() => (this.rev(), this.history?.canUndo ?? false));
  protected readonly canRedo = computed(() => (this.rev(), this.history?.canRedo ?? false));

  /** The selection's oriented frame (unit box → world), or null. */
  private readonly frameBox = computed<Mat2D | null>(() => {
    this.rev();
    const sel = this.selection();
    return sel.ids.size && this.selectable() ? selectionFrame(this.document, sel.ids) : null;
  });

  /** The frame + handles projected to CSS px over the stage (an SVG overlay). */
  protected readonly overlay = computed(() => {
    const f = this.frameBox();
    if (!f) return null;
    const cam = this.camera();
    const s = (p: Vec2) => worldToScreen(cam, p);
    const placed = handles(f).map((h) => ({ id: h.id, ...s(h.point) }));
    const grips = placed.filter((h) => h.id !== 'rotate');
    const corner = (id: HandleId) => placed.find((h) => h.id === id)!;
    const nw = corner('nw');
    const ne = corner('ne');
    const se = corner('se');
    const sw = corner('sw');
    const rot = corner('rotate');
    const topC = s(transformPoint(f, vec2(0.5, 0)));
    return {
      poly: `${nw.x},${nw.y} ${ne.x},${ne.y} ${se.x},${se.y} ${sw.x},${sw.y}`,
      grips,
      rotate: rot,
      topC,
    };
  });

  /** Alignment guides projected to CSS px (each an x1/y1→x2/y2 line segment). */
  protected readonly guideLines = computed(() => {
    const cam = this.camera();
    return this.snapGuides().map((g) => {
      const a = worldToScreen(cam, g.axis === 'x' ? vec2(g.position, g.start) : vec2(g.start, g.position));
      const b = worldToScreen(cam, g.axis === 'x' ? vec2(g.position, g.end) : vec2(g.end, g.position));
      return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    });
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
    this.history = new History(this.document, { limit: 200 });
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
    const pt = this.toCanvas(event, canvas);

    // Editing: grab a handle, or the body of an already-selected shape, to
    // transform instead of pan. Everything else falls through to pan/select.
    if (this.selectable()) {
      const ov = this.overlay();
      const grip = ov ? handleAt([...ov.grips, ov.rotate].map((h) => ({ id: h.id, point: vec2(h.x, h.y) })), pt, 11) : null;
      if (grip) {
        this.startDrag(grip, pt);
        return;
      }
      if (this.selection().ids.size) {
        const hit = hitTest(this.document, screenToWorld(this.camera(), pt), { tolerance: 6 / this.camera().zoom, select: 'outermost' });
        if (hit && this.selection().ids.has(hit)) {
          this.startDrag('move', pt);
          return;
        }
      }
    }
    this.gesture.down(event.pointerId, pt);
  }

  protected onPointerMove(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    const pt = this.toCanvas(event, canvas);
    if (this.dragHandle && this.dragBox && this.dragStart) {
      this.pointerMoved = true;
      this.beginInteraction();
      let delta = dragTransform(this.dragBox, this.dragHandle, this.dragStart, screenToWorld(this.camera(), pt), {
        uniform: event.shiftKey,
        fromCentre: event.altKey,
      });
      // A move-drag snaps its translation to nearby shapes' edges/centres, unless
      // a modifier is held for free movement. Resize/rotate never snap.
      if (this.dragHandle === 'move' && !(event.ctrlKey || event.metaKey)) {
        const res = snapMove(this.document, [...this.dragSnapshot.keys()], this.dragBounds, vec2(delta.e, delta.f), {
          threshold: 6 / this.camera().zoom,
        });
        delta = { a: 1, b: 0, c: 0, d: 1, e: res.delta.x, f: res.delta.y };
        this.snapGuides.set(res.guides);
      }
      this.dragDelta = delta;
      // Live preview only — not recorded. Restore the snapshot, then apply the
      // from-start delta (so the drag never compounds).
      const run = (): void => {
        for (const [id, t] of this.dragSnapshot) this.document.update(id, { transform: t });
        applyTransform(this.document, [...this.dragSnapshot.keys()], delta);
      };
      if (this.history) this.history.withoutHistory(run);
      else run();
      this.rev.update((v) => v + 1);
      this.draw();
      return;
    }
    const change = this.gesture.move(event.pointerId, pt);
    if (change) {
      this.pointerMoved = true;
      this.beginInteraction();
      this.applyGesture(change);
    }
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.dragHandle) {
      // Commit the whole drag as ONE undo entry: restore to the pre-drag snapshot
      // without history, then apply the net delta inside a transaction (records a
      // single before→after per node).
      if (this.dragDelta && this.history) {
        const ids = [...this.dragSnapshot.keys()];
        const snap = this.dragSnapshot;
        const delta = this.dragDelta;
        this.history.withoutHistory(() => {
          for (const [id, t] of snap) this.document.update(id, { transform: t });
        });
        this.document.transaction(() => applyTransform(this.document, ids, delta));
        this.rev.update((v) => v + 1);
      }
      this.dragHandle = null;
      this.dragBox = null;
      this.dragStart = null;
      this.dragDelta = null;
      this.dragBounds = null;
      this.dragSnapshot.clear();
      this.snapGuides.set([]);
      return;
    }
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

  /** Begin a handle drag: freeze the frame + start point and snapshot transforms. */
  private startDrag(handle: HandleId, canvasPt: Vec2): void {
    this.dragHandle = handle;
    this.dragBox = this.frameBox();
    this.dragStart = screenToWorld(this.camera(), canvasPt);
    this.dragDelta = null;
    this.dragSnapshot = new Map();
    for (const id of this.selection().ids) {
      const node = this.document.get(id) as SpatialNode | undefined;
      if (node && 'transform' in node) this.dragSnapshot.set(id, node.transform);
    }
    this.dragBounds = selectionBounds(this.document, [...this.dragSnapshot.keys()]);
    this.beginInteraction();
  }

  /** Undo the last edit (a whole drag is one step). */
  protected undo(): void {
    if (this.history?.undo()) this.afterHistory();
  }

  /** Redo the last undone edit. */
  protected redo(): void {
    if (this.history?.redo()) this.afterHistory();
  }

  private afterHistory(): void {
    // History only changed transforms here, but prune in case a future edit
    // removed a selected node.
    this.selection.update((s) => pruneSelection(s, this.document));
    this.rev.update((v) => v + 1);
    this.draw();
  }

  /** Arrow-key nudge distance in world units (Shift = a coarser step). */
  private static readonly NUDGE = 1;
  private static readonly NUDGE_SHIFT = 10;

  /**
   * Keyboard editing (selectable scenes only):
   * - Cmd/Ctrl+Z = undo, +Shift or Ctrl+Y = redo
   * - Cmd/Ctrl+D = duplicate the selection (offset copies, then select them)
   * - Delete / Backspace = remove the selection
   * - Arrow keys = nudge the selection (Shift = a coarser step)
   *
   * Each edit records as a single undo entry (the ops wrap themselves in one
   * transaction), then refreshes the frame overlay and redraws.
   */
  protected onKey(event: KeyboardEvent): void {
    if (!this.selectable()) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (mod && (key === 'z' || key === 'Z')) {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && (key === 'y' || key === 'Y')) {
      event.preventDefault();
      this.redo();
      return;
    }
    if (mod && (key === 'd' || key === 'D')) {
      event.preventDefault();
      this.duplicateSelection();
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    const nudge: Record<string, Vec2> = {
      ArrowLeft: vec2(-1, 0), ArrowRight: vec2(1, 0), ArrowUp: vec2(0, -1), ArrowDown: vec2(0, 1),
    };
    const dir = nudge[key];
    if (dir) {
      event.preventDefault();
      this.nudgeSelection(dir, event.shiftKey);
    }
  }

  /** Nudge the selection by `dir` × the (shift-scaled) step. One undo entry. */
  private nudgeSelection(dir: Vec2, coarse: boolean): void {
    const ids = [...this.selection().ids];
    if (!ids.length) return;
    const step = coarse ? WebGpuScene.NUDGE_SHIFT : WebGpuScene.NUDGE;
    nudgeNodes(this.document, ids, dir.x * step, dir.y * step);
    this.rev.update((v) => v + 1);
    this.draw();
  }

  /** Delete the selected nodes (and subtrees) and clear the selection. */
  private deleteSelection(): void {
    const ids = [...this.selection().ids];
    if (!ids.length) return;
    deleteNodes(this.document, ids);
    this.selection.set(EMPTY_SELECTION);
    this.rev.update((v) => v + 1);
    this.draw();
  }

  /** Duplicate the selected subtrees and select the copies. One undo entry. */
  private duplicateSelection(): void {
    const ids = [...this.selection().ids];
    if (!ids.length) return;
    const copies = duplicateNodes(this.document, ids);
    if (copies.length) this.selection.set(createSelection(copies));
    this.rev.update((v) => v + 1);
    this.draw();
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
