/**
 * Align & distribute — the multi-selection tidy-up commands, as pure functions
 * over a `SceneDocument` (DOM-free, unit-tested).
 *
 * `alignNodes` moves every selected node so a chosen edge or centre lines up with
 * the selection's overall bounding box (align-left snaps all left edges to the
 * group's left, align-centre centres them, etc.). `distributeNodes` spreads three
 * or more nodes so their centres are evenly spaced along an axis, holding the two
 * extremes fixed. Both operate on world bounds and translate through
 * `applyTransform` (parent-aware), and each runs in one transaction — one undo
 * step.
 */

import type { Bounds } from './bounds';
import type { SceneDocument } from './document';
import { selectionBounds } from './hit-test';
import type { NodeId } from './id';
import { fromTranslation } from './matrix';
import { applyTransform } from './transform-handles';
import { vec2 } from './vec2';

/** Which edge/centre of each node aligns to the selection box. */
export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** The axis to even out spacing along. */
export type DistributeAxis = 'horizontal' | 'vertical';

/** The world bounds of each node that has geometry, paired with its id. */
function boundsList(doc: SceneDocument, ids: Iterable<NodeId>): { id: NodeId; b: Bounds }[] {
  const out: { id: NodeId; b: Bounds }[] = [];
  for (const id of ids) {
    const b = doc.getWorldBounds(id);
    if (b) out.push({ id, b });
  }
  return out;
}

/** The world-space translation that aligns box `b` to `frame` for `edge`. */
function offsetFor(edge: AlignEdge, b: Bounds, frame: Bounds): { dx: number; dy: number } {
  switch (edge) {
    case 'left': return { dx: frame.minX - b.minX, dy: 0 };
    case 'right': return { dx: frame.maxX - b.maxX, dy: 0 };
    case 'hcenter': return { dx: (frame.minX + frame.maxX) / 2 - (b.minX + b.maxX) / 2, dy: 0 };
    case 'top': return { dx: 0, dy: frame.minY - b.minY };
    case 'bottom': return { dx: 0, dy: frame.maxY - b.maxY };
    case 'vcenter': return { dx: 0, dy: (frame.minY + frame.maxY) / 2 - (b.minY + b.maxY) / 2 };
  }
}

/**
 * Align every selected node's `edge` to the selection's overall bounding box.
 * Needs two or more nodes with geometry; otherwise a no-op. One undo step.
 */
export function alignNodes(doc: SceneDocument, ids: Iterable<NodeId>, edge: AlignEdge): void {
  const list = boundsList(doc, ids);
  if (list.length < 2) return;
  const frame = selectionBounds(doc, list.map((e) => e.id));
  if (!frame) return;
  doc.transaction(() => {
    for (const { id, b } of list) {
      const { dx, dy } = offsetFor(edge, b, frame);
      if (dx !== 0 || dy !== 0) applyTransform(doc, [id], fromTranslation(vec2(dx, dy)));
    }
  });
}

/**
 * Evenly space three or more nodes' centres along `axis`, holding the two extreme
 * nodes fixed. Fewer than three nodes is a no-op (nothing between the extremes).
 * One undo step.
 */
export function distributeNodes(doc: SceneDocument, ids: Iterable<NodeId>, axis: DistributeAxis): void {
  const list = boundsList(doc, ids);
  if (list.length < 3) return;
  const horizontal = axis === 'horizontal';
  const centre = (b: Bounds): number => (horizontal ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2);
  const sorted = list.slice().sort((p, q) => centre(p.b) - centre(q.b));
  const first = centre(sorted[0].b);
  const last = centre(sorted[sorted.length - 1].b);
  const step = (last - first) / (sorted.length - 1);
  doc.transaction(() => {
    // Skip the two extremes (i = 0 and i = n-1) — they anchor the spread.
    for (let i = 1; i < sorted.length - 1; i++) {
      const target = first + step * i;
      const delta = target - centre(sorted[i].b);
      if (delta !== 0) applyTransform(doc, [sorted[i].id], fromTranslation(horizontal ? vec2(delta, 0) : vec2(0, delta)));
    }
  });
}
