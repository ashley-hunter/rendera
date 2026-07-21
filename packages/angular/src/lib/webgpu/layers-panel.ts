import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import {
  layerRows,
  type DropPlacement,
  type LayerRow,
  type NodeId,
  type SceneDocument,
  type Selection,
} from '@rendera/core';

/** A reorder request emitted after a successful drag-drop. */
export interface LayerReorder {
  readonly id: NodeId;
  readonly targetId: NodeId;
  readonly placement: DropPlacement;
}

/** A drop target while dragging: the row under the pointer and where it'd land. */
interface DropHint {
  readonly targetId: NodeId;
  readonly placement: DropPlacement;
}

/**
 * The layers panel: the document tree as an indented, front-to-back row list.
 * Rows show a visibility toggle and a type glyph; clicking selects (shift adds),
 * the caret collapses a container, and rows drag to reorder / reparent. The panel
 * is presentational — it reads the document + selection and emits intents; the
 * host applies them (through history) and bumps `rev` to refresh.
 */
@Component({
  selector: 'rendera-layers-panel',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './layers-panel.html',
  styleUrl: './layers-panel.css',
})
export class LayersPanel {
  /** The document whose tree is shown. */
  readonly document = input.required<SceneDocument>();
  /** The current selection (highlights rows). */
  readonly selection = input<Selection>({ ids: new Set(), primary: null });
  /** Bump to recompute the tree after an external mutation (the doc isn't a signal). */
  readonly rev = input(0);

  /** Emitted when a row is chosen (additive = shift/ctrl held). */
  readonly selectRow = output<{ id: NodeId; additive: boolean }>();
  /** Emitted to toggle a node's visibility. */
  readonly toggleVisible = output<NodeId>();
  /** Emitted after a successful drag-drop reorder. */
  readonly reorder = output<LayerReorder>();

  /** Collapsed container ids (local panel state). */
  private readonly collapsed = signal<ReadonlySet<NodeId>>(new Set());
  /** The row currently being dragged, and the live drop hint. */
  protected readonly dragId = signal<NodeId | null>(null);
  protected readonly dropHint = signal<DropHint | null>(null);

  /** The flattened rows, front-to-back. */
  protected readonly rows = computed<LayerRow[]>(() => {
    this.rev();
    return layerRows(this.document(), { collapsed: this.collapsed() });
  });

  protected isSelected(id: NodeId): boolean {
    return this.selection().ids.has(id);
  }

  protected onSelect(row: LayerRow, event: Event): void {
    const e = event as MouseEvent & KeyboardEvent;
    if (event.type !== 'click') event.preventDefault(); // stop Space scrolling on keyboard
    this.selectRow.emit({ id: row.id, additive: e.shiftKey || e.ctrlKey || e.metaKey });
  }

  protected onToggleVisible(row: LayerRow, event: Event): void {
    event.stopPropagation();
    this.toggleVisible.emit(row.id);
  }

  protected onToggleCollapse(row: LayerRow, event: Event): void {
    event.stopPropagation();
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }

  // --- drag & drop ---------------------------------------------------------

  protected onDragStart(row: LayerRow, event: DragEvent): void {
    this.dragId.set(row.id);
    event.dataTransfer?.setData('text/plain', row.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(row: LayerRow, event: DragEvent): void {
    const dragId = this.dragId();
    if (!dragId || dragId === row.id) return;
    event.preventDefault(); // allow the drop
    this.dropHint.set({ targetId: row.id, placement: this.placementFor(row, event) });
  }

  protected onDrop(_row: LayerRow, event: DragEvent): void {
    event.preventDefault();
    const dragId = this.dragId();
    const hint = this.dropHint();
    this.clearDrag();
    if (!dragId || !hint) return;
    // The panel never mutates the document — it emits the intent and the host
    // applies it through history (`moveNode` there validates + records it).
    this.reorder.emit({ id: dragId, targetId: hint.targetId, placement: hint.placement });
  }

  protected onDragEnd(): void {
    this.clearDrag();
  }

  /** Whether `row` is the current drop target, and where the line shows. */
  protected dropClass(row: LayerRow): string {
    const hint = this.dropHint();
    if (!hint || hint.targetId !== row.id) return '';
    return `drop-${hint.placement}`;
  }

  private clearDrag(): void {
    this.dragId.set(null);
    this.dropHint.set(null);
  }

  /** Above / inside / below from the pointer's position within the row. */
  private placementFor(row: LayerRow, event: DragEvent): DropPlacement {
    const el = event.currentTarget as HTMLElement | null;
    if (!el) return 'below';
    const rect = el.getBoundingClientRect();
    const t = (event.clientY - rect.top) / rect.height;
    if (row.container) {
      if (t < 0.25) return 'above';
      if (t > 0.75) return 'below';
      return 'inside';
    }
    return t < 0.5 ? 'above' : 'below';
  }
}
