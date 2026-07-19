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
  fitBounds,
  History,
  panBy,
  SceneDocument,
  screenToWorld,
  vec2,
  zoomAround,
  type Camera,
  type GroupNode,
  type LayerNode,
  type NodeId,
  type SceneNode,
} from '@rendera/core';
import { drawScene } from './draw-scene';

interface TreeRow {
  id: NodeId;
  name: string;
  type: string;
  depth: number;
}

function nodeName(node: SceneNode): string {
  return (node as { name?: string }).name ?? node.type;
}

/** Seed a small sample scene (not recorded in history — created before it). */
function createSampleDocument(): SceneDocument {
  const doc = SceneDocument.create({ name: 'Inspector' });
  const group = doc.insert<GroupNode>({
    type: 'group',
    name: 'Group',
    transform: createTransform({ translation: vec2(80, 70) }),
  });
  doc.insert<LayerNode>(
    { type: 'layer', name: 'A', size: vec2(120, 80) },
    { parentId: group.id }
  );
  doc.insert<LayerNode>(
    {
      type: 'layer',
      name: 'B',
      size: vec2(90, 90),
      transform: createTransform({ translation: vec2(80, 60), rotation: 0.3 }),
    },
    { parentId: group.id }
  );
  doc.insert<LayerNode>({
    type: 'layer',
    name: 'C',
    size: vec2(110, 60),
    transform: createTransform({ translation: vec2(280, 40) }),
  });
  return doc;
}

/**
 * Debug/showcase view of a `SceneDocument`, driving the framework-agnostic
 * kernel end-to-end: a Canvas2D visualization plus pan/zoom, click-to-select
 * (via `hitTest`), mutations, and undo/redo. This is NOT the product renderer
 * (that is the WebGPU backend, Phase 2).
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
  protected readonly selectedId = signal<NodeId | null>(null);
  /** Bumped on every document change to drive tree/redraw recomputation. */
  private readonly revision = signal(0);

  private layerCounter = 0;
  private dragging = false;
  private moved = false;
  private lastPointer: { x: number; y: number } | null = null;
  private resizeObserver?: ResizeObserver;

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
      this.selectedId();
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
    this.selectedId.set(layer.id);
  }

  protected deleteSelected(): void {
    const id = this.selectedId();
    if (!id || id === this.document.root.id) {
      return;
    }
    this.document.remove(id);
    this.selectedId.set(null);
  }

  protected undo(): void {
    this.history.undo();
    this.pruneSelection();
  }

  protected redo(): void {
    this.history.redo();
    this.pruneSelection();
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

  protected select(id: NodeId): void {
    this.selectedId.set(id);
  }

  protected onPointerDown(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    canvas?.setPointerCapture?.(event.pointerId);
    this.dragging = true;
    this.moved = false;
    this.lastPointer = this.toCanvas(event);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.dragging || !this.lastPointer) {
      return;
    }
    const p = this.toCanvas(event);
    const dx = p.x - this.lastPointer.x;
    const dy = p.y - this.lastPointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      this.moved = true;
    }
    this.camera.update((c) => panBy(c, vec2(dx, dy)));
    this.lastPointer = p;
  }

  protected onPointerUp(event: PointerEvent): void {
    const wasDrag = this.moved;
    this.dragging = false;
    this.lastPointer = null;
    if (wasDrag) {
      return;
    }
    const p = this.toCanvas(event);
    const world = screenToWorld(this.camera(), vec2(p.x, p.y));
    const hit = this.document.hitTest(world);
    this.selectedId.set(hit ? hit.id : null);
  }

  protected onWheel(event: WheelEvent): void {
    event.preventDefault();
    const p = this.toCanvas(event);
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.camera.update((c) => zoomAround(c, vec2(p.x, p.y), factor));
  }

  private toCanvas(event: MouseEvent): { x: number; y: number } {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return { x: 0, y: 0 };
    }
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private pruneSelection(): void {
    const id = this.selectedId();
    if (id && !this.document.has(id)) {
      this.selectedId.set(null);
    }
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
      selectedId: this.selectedId(),
    });
  }
}
