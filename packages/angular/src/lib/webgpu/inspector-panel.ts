import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  BLEND_MODES,
  hexToLinear,
  linearToHex,
  type BlendMode,
  type NodeId,
  type Paint,
  type SceneDocument,
  type Selection,
  type SpatialNode,
} from '@rendera/core';

/** A node that may carry a `fill` and/or `stroke` (path / text / layer / boolean). */
interface Painted extends SpatialNode {
  fill?: Paint;
  stroke?: { paint: Paint; width: number };
}

/** The resolved view-model the template renders (null when nothing is selected). */
interface InspectorModel {
  readonly count: number;
  readonly opacity: number; // 0–100
  readonly blendMode: BlendMode;
  readonly visible: boolean;
  /** Present only for a single-node selection. */
  readonly single: {
    readonly type: string;
    readonly fillHex: string | null;
    readonly strokeHex: string | null;
    readonly strokeWidth: number | null;
    readonly x: number;
    readonly y: number;
  } | null;
}

const solidHex = (paint: Paint | undefined): string | null =>
  paint && paint.type === 'solid' ? linearToHex(paint.color) : null;

/**
 * The properties inspector: edit the selection's opacity, blend mode, visibility,
 * fill/stroke colour, stroke width, and position. Common controls (opacity, blend,
 * visible) apply to every selected node; fill/stroke/position show for a single
 * selection. It edits the shared document directly — each change is one undo entry
 * (history records the document's change stream) — and emits `changed` so the host
 * refreshes the canvas + frame.
 */
@Component({
  selector: 'rendera-inspector-panel',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inspector-panel.html',
  styleUrl: './inspector-panel.css',
})
export class InspectorPanel {
  readonly document = input.required<SceneDocument>();
  readonly selection = input<Selection>({ ids: new Set(), primary: null });
  /** Bump to recompute after an external mutation (the doc isn't a signal). */
  readonly rev = input(0);

  /** Emitted after any edit so the host bumps its rev and redraws. */
  readonly changed = output<void>();

  protected readonly blendModes = BLEND_MODES;

  /** The view-model, derived from the primary selected node. */
  protected readonly model = computed<InspectorModel | null>(() => {
    this.rev();
    const sel = this.selection();
    const ids = [...sel.ids];
    if (ids.length === 0) return null;
    const primaryId = sel.primary ?? ids[ids.length - 1];
    const primary = this.document().get(primaryId) as Painted | undefined;
    if (!primary) return null;
    const single = ids.length === 1 && 'transform' in primary
      ? {
          type: primary.type,
          fillHex: solidHex(primary.fill),
          strokeHex: solidHex(primary.stroke?.paint),
          strokeWidth: primary.stroke ? primary.stroke.width : null,
          x: round(primary.transform.translation.x),
          y: round(primary.transform.translation.y),
        }
      : null;
    return {
      count: ids.length,
      opacity: Math.round((primary.opacity ?? 1) * 100),
      blendMode: primary.blendMode ?? 'normal',
      visible: primary.visible !== false,
      single,
    };
  });

  // --- edits (apply to the selection, record + redraw) ---------------------

  private eachSelected(fn: (node: SpatialNode, id: NodeId) => void): void {
    const doc = this.document();
    for (const id of this.selection().ids) {
      const node = doc.get(id) as SpatialNode | undefined;
      if (node && 'transform' in node) fn(node, id);
    }
    this.changed.emit();
  }

  protected setOpacity(value: string): void {
    const opacity = Math.min(1, Math.max(0, Number(value) / 100));
    this.eachSelected((_n, id) => this.document().update(id, { opacity }));
  }

  protected setBlend(value: string): void {
    this.eachSelected((_n, id) => this.document().update(id, { blendMode: value as BlendMode }));
  }

  protected setVisible(checked: boolean): void {
    this.eachSelected((_n, id) => this.document().update(id, { visible: checked }));
  }

  private primaryId(): NodeId | null {
    const sel = this.selection();
    if (sel.primary) return sel.primary;
    const ids = [...sel.ids];
    return ids.length ? ids[ids.length - 1] : null;
  }

  private updatePrimary(patch: Record<string, unknown>): void {
    const id = this.primaryId();
    if (!id) return;
    this.document().update(id, patch);
    this.changed.emit();
  }

  protected setFill(hex: string): void {
    const id = this.primaryId();
    if (!id) return;
    const node = this.document().get(id) as Painted | undefined;
    const alpha = node?.fill?.type === 'solid' ? node.fill.color.a : 1;
    this.updatePrimary({ fill: { type: 'solid', color: hexToLinear(hex, alpha) } as Paint });
  }

  protected setStrokeColor(hex: string): void {
    const id = this.primaryId();
    if (!id) return;
    const node = this.document().get(id) as Painted | undefined;
    if (!node?.stroke) return;
    const alpha = node.stroke.paint.type === 'solid' ? node.stroke.paint.color.a : 1;
    this.updatePrimary({ stroke: { ...node.stroke, paint: { type: 'solid', color: hexToLinear(hex, alpha) } as Paint } });
  }

  protected setStrokeWidth(value: string): void {
    const id = this.primaryId();
    if (!id) return;
    const node = this.document().get(id) as Painted | undefined;
    if (!node?.stroke) return;
    this.updatePrimary({ stroke: { ...node.stroke, width: Math.max(0, Number(value)) } });
  }

  protected setX(value: string): void {
    const id = this.primaryId();
    const node = id ? (this.document().get(id) as SpatialNode | undefined) : undefined;
    if (!node) return;
    this.updatePrimary({ transform: { ...node.transform, translation: { x: Number(value), y: node.transform.translation.y } } });
  }

  protected setY(value: string): void {
    const id = this.primaryId();
    const node = id ? (this.document().get(id) as SpatialNode | undefined) : undefined;
    if (!node) return;
    this.updatePrimary({ transform: { ...node.transform, translation: { x: node.transform.translation.x, y: Number(value) } } });
  }
}

/** Round to 2 dp for display (avoids long float tails in number inputs). */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}
