import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  signal,
  viewChild,
} from '@angular/core';
import {
  createCamera,
  createTransform,
  EMPTY_SELECTION,
  fitBounds,
  History,
  isAdditive,
  isSelected,
  panBy,
  pointerToWorld,
  pruneSelection,
  resolveSelectionClick,
  selectionSize,
  selectOnly,
  vec2,
  ViewportGesture,
  zoomAround,
  type Camera,
  type LayerNode,
  type NodeId,
  type SceneNode,
  type Selection,
  type ViewportGestureChange,
} from '@rendera/core';
import { createSampleDocument } from '../sample-scene';
import { drawScene } from './draw-scene';
import { toPointerInput } from './pointer-input';

interface TreeRow {
  id: NodeId;
  name: string;
  type: string;
  depth: number;
}

function nodeName(node: SceneNode): string {
  return (node as { name?: string }).name ?? node.type;
}

/**
 * Debug/showcase view of a `SceneDocument`, driving the framework-agnostic
 * kernel end-to-end: a Canvas2D visualization plus pan/zoom, click and
 * shift-click selection (via `PointerInput` + `hitTest` + `Selection`),
 * mutations, and undo/redo. Not the product renderer (WebGPU is Phase 2).
 */
@Component({
  selector: 'rendera-scene-inspector',
  imports: [],
  templateUrl: './scene-inspector.html',
  styleUrl: './scene-inspector.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SceneInspector {
  private readonly canvasRef =
    viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly document = createSampleDocument();
  private readonly history = new History(this.document);

  protected readonly camera = signal<Camera>(createCamera());
  protected readonly selection = signal<Selection>(EMPTY_SELECTION);
  private readonly revision = signal(0);

  private layerCounter = 0;
  private readonly gesture = new ViewportGesture();
  private moved = false;
  private resizeObserver?: ResizeObserver;

  protected readonly hasSelection = computed(
    () => selectionSize(this.selection()) > 0
  );

  protected readonly tree = computed<TreeRow[]>(() => {
    this.revision();
    const rows: TreeRow[] = [];
    const walk = (id: NodeId, depth: number): void => {
      const node = this.document.get(id);
      if (!node) {
        return;
      }
      rows.push({ id, name: nodeName(node), type: node.type, depth });
      for (const child of this.document.getChildren(id)) {
        walk(child.id, depth + 1);
      }
    };
    walk(this.document.root.id, 0);
    return rows;
  });

  protected readonly canUndo = computed(() => {
    this.revision();
    return this.history.canUndo;
  });
  protected readonly canRedo = computed(() => {
    this.revision();
    return this.history.canRedo;
  });

  constructor() {
    this.document.subscribe(() => this.revision.update((v) => v + 1));
    effect(() => {
      this.camera();
      this.selection();
      this.revision();
      this.draw();
    });
    afterNextRender(() => {
      const canvas = this.canvasRef()?.nativeElement;
      if (canvas && typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas);
      }
      this.resize();
    });
  }

  protected isRowSelected(id: NodeId): boolean {
    return isSelected(this.selection(), id);
  }

  protected addLayer(): void {
    const n = ++this.layerCounter;
    const layer = this.document.insert<LayerNode>({
      type: 'layer',
      name: `Layer ${n}`,
      size: vec2(90, 70),
      transform: createTransform({
        translation: vec2((n * 40) % 320, (n * 30) % 220),
      }),
    });
    this.selection.set(selectOnly(this.selection(), layer.id));
  }

  protected deleteSelected(): void {
    const ids = [...this.selection().ids].filter(
      (id) => id !== this.document.root.id
    );
    if (ids.length === 0) {
      return;
    }
    this.document.transaction(() => {
      for (const id of ids) {
        if (this.document.has(id)) {
          this.document.remove(id);
        }
      }
    });
    this.selection.set(EMPTY_SELECTION);
  }

  protected undo(): void {
    this.history.undo();
    this.selection.update((s) => pruneSelection(s, this.document));
  }

  protected redo(): void {
    this.history.redo();
    this.selection.update((s) => pruneSelection(s, this.document));
  }

  protected fit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const bounds = this.document.getWorldBounds(this.document.root.id);
    if (!canvas || !bounds) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    this.camera.set(
      fitBounds(bounds, { width: rect.width, height: rect.height }, 40)
    );
  }

  protected selectRow(id: NodeId): void {
    this.selection.set(selectOnly(this.selection(), id));
  }

  protected onPointerDown(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // Ignore: the pointer may not be active (e.g. a synthetic event in tests).
    }
    const screen = toPointerInput(event, canvas, 'down').screen;
    this.gesture.down(event.pointerId, screen);
    // A fresh single-finger touch may still be a tap; a second finger never is.
    this.moved = this.gesture.activeCount > 1;
  }

  protected onPointerMove(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    const screen = toPointerInput(event, canvas, 'move').screen;
    const change = this.gesture.move(event.pointerId, screen);
    if (!change) {
      return;
    }
    if (Math.abs(change.pan.x) + Math.abs(change.pan.y) > 2 || change.zoom !== 1) {
      this.moved = true;
    }
    this.applyGesture(change);
  }

  protected onPointerUp(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    // A tap is a single finger lifting with no pan/pinch in between.
    const isTap = !this.moved && this.gesture.activeCount === 1;
    this.gesture.up(event.pointerId);
    if (!isTap || !canvas) {
      return;
    }
    const input = toPointerInput(event, canvas, 'up');
    const world = pointerToWorld(input, this.camera());
    const hit = this.document.hitTest(world);
    this.selection.update((s) =>
      resolveSelectionClick(s, hit ? hit.id : null, {
        additive: isAdditive(input.modifiers),
      })
    );
  }

  protected onPointerCancel(event: PointerEvent): void {
    this.moved = true;
    this.gesture.up(event.pointerId);
  }

  protected onWheel(event: WheelEvent): void {
    event.preventDefault();
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const anchor = vec2(event.clientX - rect.left, event.clientY - rect.top);
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.camera.update((c) => zoomAround(c, anchor, factor));
  }

  /** Apply a recognizer change (single-finger pan or two-finger pinch) to the camera. */
  private applyGesture(change: ViewportGestureChange): void {
    this.camera.update((c) => {
      const panned = panBy(c, change.pan);
      return change.zoom === 1 ? panned : zoomAround(panned, change.anchor, change.zoom);
    });
  }

  private resize(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    const dpr = globalThis.devicePixelRatio ?? 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.draw();
  }

  private draw(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    drawScene(ctx, this.document, this.camera(), {
      width: canvas.width,
      height: canvas.height,
      dpr: globalThis.devicePixelRatio ?? 1,
      selectedIds: this.selection().ids,
    });
  }
}
