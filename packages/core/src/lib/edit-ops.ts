/**
 * Editor document commands — delete, duplicate, and nudge a selection, as pure
 * operations over a `SceneDocument` (DOM-free, unit-tested).
 *
 * Each command is wrapped in a single `transaction`, so it lands as one undoable
 * step. Commands operate on the selection's **roots** (an id whose ancestor is
 * also selected is skipped — deleting/duplicating the ancestor already covers it),
 * so behaviour is well-defined for nested selections.
 */

import type { SceneDocument } from './document';
import type { NodeId } from './id';
import { fromTranslation } from './matrix';
import type { NodeInput, SceneNode, SpatialNode } from './node';
import { applyTransform } from './transform-handles';
import { vec2 } from './vec2';

/** The selected ids with none that is a descendant of another selected id. */
export function roots(doc: SceneDocument, ids: Iterable<NodeId>): NodeId[] {
  const set = new Set(ids);
  const out: NodeId[] = [];
  for (const id of set) {
    let p = doc.get(id)?.parentId ?? null;
    let covered = false;
    while (p) {
      if (set.has(p)) {
        covered = true;
        break;
      }
      p = doc.get(p)?.parentId ?? null;
    }
    if (!covered) out.push(id);
  }
  return out;
}

/** Deep-clone `id`'s subtree under `newParent`, returning the new root id. */
function cloneSubtree(doc: SceneDocument, id: NodeId, newParent: NodeId): NodeId | null {
  const node = doc.get(id);
  if (!node) return null;
  // Structural keys (id/parentId/index) are re-assigned by insert; everything
  // else — type and all data — is carried over verbatim.
  const { id: _id, parentId: _parent, index: _index, ...rest } = node;
  const created = doc.insert(rest as NodeInput<SceneNode>, { parentId: newParent });
  for (const child of doc.getChildren(id)) cloneSubtree(doc, child.id, created.id);
  return created.id;
}

/** Remove the selected nodes (and their subtrees). One undo step. */
export function deleteNodes(doc: SceneDocument, ids: Iterable<NodeId>): void {
  doc.transaction(() => {
    for (const id of roots(doc, ids)) {
      if (doc.get(id)) doc.remove(id);
    }
  });
}

/**
 * Duplicate the selected subtrees as siblings, each offset by `(dx, dy)` in its
 * parent's space, and return the new root ids (for re-selecting the copies). One
 * undo step.
 */
export function duplicateNodes(doc: SceneDocument, ids: Iterable<NodeId>, dx = 10, dy = 10): NodeId[] {
  return doc.transaction(() => {
    const out: NodeId[] = [];
    for (const id of roots(doc, ids)) {
      const node = doc.get(id);
      if (!node || node.parentId == null) continue; // skip the root / missing
      const copy = cloneSubtree(doc, id, node.parentId);
      if (!copy) continue;
      const c = doc.get(copy) as SpatialNode;
      if ('transform' in c) {
        const t = c.transform;
        doc.update(copy, { transform: { ...t, translation: { x: t.translation.x + dx, y: t.translation.y + dy } } });
      }
      out.push(copy);
    }
    return out;
  });
}

/** Translate the selection by `(dx, dy)` world units (arrow-key nudge). One step. */
export function nudgeNodes(doc: SceneDocument, ids: Iterable<NodeId>, dx: number, dy: number): void {
  const arr = [...ids];
  if (arr.length === 0) return;
  doc.transaction(() => applyTransform(doc, arr, fromTranslation(vec2(dx, dy))));
}
