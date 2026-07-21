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
  alignNodes,
  applyTransform,
  buildRenderList,
  createCamera,
  createSelection,
  distributeNodes,
  deleteNodes,
  dragTransform,
  duplicateNodes,
  EMPTY_SELECTION,
  exportSvg,
  fitBounds,
  groupNodes,
  handleAt,
  handles,
  History,
  hitTest,
  layoutTextNode,
  layoutTextNodeGlyphs,
  makeBoolean,
  moveNode,
  MsdfAtlas,
  nodesInBox,
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
  ungroupNodes,
  vec2,
  ViewportGesture,
  withPixelRatio,
  worldToScreen,
  zoomAround,
  type AlignEdge,
  type BooleanOp,
  type Bounds,
  type Camera,
  type DistributeAxis,
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
import { InspectorPanel } from './inspector-panel';
import { LayersPanel, type LayerReorder } from './layers-panel';

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
  imports: [LayersPanel, InspectorPanel],
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
  /** Show the layers panel beside the canvas (default off; implies selectable). */
  readonly showLayers = input(false);
  /** Show the properties inspector beside the canvas (default off; implies selectable). */
  readonly showInspector = input(false);

  /** The document exposed to the layers panel. */
  protected doc(): SceneDocument {
    return this.document;
  }
  /** The revision counter exposed to the layers panel (recompute trigger). */
  protected revValue(): number {
    return this.rev();
  }

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

  /** Whether Space is held (temporarily switches empty-drag from marquee to pan). */
  private panKey = false;
  /** Marquee start point in canvas px (null when not rubber-band selecting). */
  private marqueeStart: Vec2 | null = null;
  private marqueeAdditive = false;
  /** The live marquee rectangle in CSS px for the overlay, or null. */
  protected readonly marquee = signal<{ x: number; y: number; w: number; h: number } | null>(null);

  /** Reactive undo/redo availability (recomputes when `rev` bumps). */
  protected readonly canUndo = computed(() => (this.rev(), this.history?.canUndo ?? false));
  protected readonly canRedo = computed(() => (this.rev(), this.history?.canRedo ?? false));

  /** Number of selected nodes (gates the align / distribute toolbar). */
  protected readonly selectionCount = computed(() => this.selection().ids.size);

  /** Whether 2+ selected nodes are path/boolean operands (gates the boolean toolbar). */
  protected readonly canBoolean = computed(() => {
    this.rev();
    let n = 0;
    for (const id of this.selection().ids) {
      const t = this.document.get(id)?.type;
      if (t === 'path' || t === 'boolean') {
        if (++n >= 2) return true;
      }
    }
    return false;
  });

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
      // Empty space (no handle, not on the selection): rubber-band select —
      // unless Space is held, which reserves the drag for panning.
      if (!this.panKey) {
        this.marqueeStart = pt;
        this.marqueeAdditive = event.shiftKey;
        return;
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
    if (this.marqueeStart) {
      this.pointerMoved = true;
      const s = this.marqueeStart;
      this.marquee.set({ x: Math.min(s.x, pt.x), y: Math.min(s.y, pt.y), w: Math.abs(pt.x - s.x), h: Math.abs(pt.y - s.y) });
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
    // Finish a rubber-band selection: pick the nodes it covers (shift adds to
    // the existing selection). A marquee with no movement is just a click.
    if (this.marqueeStart) {
      const canvas = this.canvasRef()?.nativeElement;
      if (this.pointerMoved && canvas) {
        const a = screenToWorld(this.camera(), this.marqueeStart);
        const b = screenToWorld(this.camera(), this.toCanvas(event, canvas));
        const boxWorld = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
        const hits = nodesInBox(this.document, boxWorld);
        this.selection.set(this.marqueeAdditive ? this.addAll(this.selection(), hits) : createSelection(hits));
        this.rev.update((v) => v + 1);
      } else if (canvas) {
        // No drag → treat as a click: clear (or shift-toggle nothing).
        const world = screenToWorld(this.camera(), this.toCanvas(event, canvas));
        const hit = hitTest(this.document, world, { tolerance: 6 / this.camera().zoom, select: 'outermost' });
        this.selection.update((s) => resolveSelectionClick(s, hit, { additive: event.shiftKey }));
      }
      this.marqueeStart = null;
      this.marquee.set(null);
      this.pointerMoved = false;
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

  /** Union `ids` into an existing selection (keeps the last as primary). */
  private addAll(sel: Selection, ids: readonly NodeId[]): Selection {
    if (ids.length === 0) return sel;
    const set = new Set(sel.ids);
    for (const id of ids) set.add(id);
    return { ids: set, primary: ids[ids.length - 1] };
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

  // --- layers panel --------------------------------------------------------

  /** A row was clicked in the layers panel: select it (shift/ctrl adds). */
  protected onLayerSelect(event: { id: NodeId; additive: boolean }): void {
    this.selection.update((s) => resolveSelectionClick(s, event.id, { additive: event.additive }));
    this.rev.update((v) => v + 1);
  }

  /** Toggle a node's visibility (one undo entry); redraw. */
  protected onLayerToggleVisible(id: NodeId): void {
    const node = this.document.get(id) as SpatialNode | undefined;
    if (!node) return;
    this.document.update(id, { visible: node.visible === false });
    this.rev.update((v) => v + 1);
    this.draw();
  }

  /** Reorder / reparent a node via drag-drop (one undo entry); redraw. */
  protected onLayerReorder(event: LayerReorder): void {
    const run = (): boolean => moveNode(this.document, event.id, event.targetId, event.placement);
    const moved = this.history ? this.history.batch(run) : run();
    if (moved) {
      this.rev.update((v) => v + 1);
      this.draw();
    }
  }

  /** The inspector edited the primary selection's properties; refresh + redraw. */
  protected onInspectorChanged(): void {
    this.rev.update((v) => v + 1);
    this.draw();
  }

  // --- align & distribute --------------------------------------------------

  /** Align the selection's chosen edge/centre to its bounding box (one undo step). */
  protected align(edge: AlignEdge): void {
    const ids = [...this.selection().ids];
    if (ids.length < 2) return;
    const run = (): void => alignNodes(this.document, ids, edge);
    if (this.history) this.history.batch(run);
    else run();
    this.rev.update((v) => v + 1);
    this.draw();
  }

  /** Evenly space the selection's centres along an axis (one undo step). */
  protected distribute(axis: DistributeAxis): void {
    const ids = [...this.selection().ids];
    if (ids.length < 3) return;
    const run = (): void => distributeNodes(this.document, ids, axis);
    if (this.history) this.history.batch(run);
    else run();
    this.rev.update((v) => v + 1);
    this.draw();
  }

  /** Combine the selected shapes into a non-destructive boolean (one undo step). */
  protected boolean(op: BooleanOp): void {
    const ids = [...this.selection().ids];
    const run = (): NodeId | null => makeBoolean(this.document, ids, op);
    const id = this.history ? this.history.batch(run) : run();
    if (id) {
      this.selection.set(createSelection([id]));
      this.rev.update((v) => v + 1);
      this.draw();
    }
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
    if (key === ' ') {
      // Hold Space to pan instead of rubber-band selecting.
      this.panKey = true;
      event.preventDefault();
      return;
    }
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
    if (mod && (key === 'g' || key === 'G')) {
      event.preventDefault();
      if (event.shiftKey) this.ungroupSelection();
      else this.groupSelection();
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

  /** Release Space → back to marquee-on-empty-drag. */
  protected onKeyUp(event: KeyboardEvent): void {
    if (event.key === ' ') this.panKey = false;
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

  /** Group the selection into a new group and select it. One undo entry. */
  private groupSelection(): void {
    const ids = [...this.selection().ids];
    if (ids.length < 2) return;
    const gid = this.history ? this.history.batch(() => groupNodes(this.document, ids)) : groupNodes(this.document, ids);
    if (gid) this.selection.set(createSelection([gid]));
    this.rev.update((v) => v + 1);
    this.draw();
  }

  /** Ungroup the selected group(s), selecting the freed children. One undo entry. */
  private ungroupSelection(): void {
    const ids = [...this.selection().ids];
    if (!ids.length) return;
    const freed = this.history ? this.history.batch(() => ungroupNodes(this.document, ids)) : ungroupNodes(this.document, ids);
    if (freed.length) this.selection.set(createSelection(freed));
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
