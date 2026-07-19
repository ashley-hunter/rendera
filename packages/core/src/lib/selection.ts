/**
 * Object selection — an immutable, per-viewer value (ADR 0004).
 *
 * A selection is a set of node ids plus a `primary` (the anchor node, e.g. the
 * one whose properties a panel shows, or the transform-origin reference).
 * Selection is ephemeral viewer state, so — like the camera — it lives outside
 * the document and never enters history or sync. All operations are pure and
 * return a new selection.
 *
 * Pixel selection (marquee/lasso masks) is a separate, later concern.
 */

import type { SceneDocument } from './document';
import type { NodeId } from './id';

export interface Selection {
  readonly ids: ReadonlySet<NodeId>;
  readonly primary: NodeId | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), primary: null };

/** Build a selection from an iterable of ids (primary = the last one). */
export function createSelection(ids: Iterable<NodeId> = []): Selection {
  const set = new Set(ids);
  let primary: NodeId | null = null;
  for (const id of set) {
    primary = id;
  }
  return { ids: set, primary };
}

export function isSelected(selection: Selection, id: NodeId): boolean {
  return selection.ids.has(id);
}

export function selectionSize(selection: Selection): number {
  return selection.ids.size;
}

/** Ids in insertion order. */
export function selectionIds(selection: Selection): NodeId[] {
  return [...selection.ids];
}

/** Replace the selection with a single node. */
export function selectOnly(_selection: Selection, id: NodeId): Selection {
  return { ids: new Set([id]), primary: id };
}

/** Add a node, making it the new primary. */
export function addToSelection(selection: Selection, id: NodeId): Selection {
  const ids = new Set(selection.ids);
  ids.add(id);
  return { ids, primary: id };
}

/** Remove a node; reassign primary to the last remaining, or null. */
export function removeFromSelection(selection: Selection, id: NodeId): Selection {
  if (!selection.ids.has(id)) {
    return selection;
  }
  const ids = new Set(selection.ids);
  ids.delete(id);
  return { ids, primary: lastOrNull(ids, selection.primary === id ? null : selection.primary) };
}

/** Toggle a node's membership. */
export function toggleSelection(selection: Selection, id: NodeId): Selection {
  return selection.ids.has(id)
    ? removeFromSelection(selection, id)
    : addToSelection(selection, id);
}

/** The empty selection. */
export function clearSelection(): Selection {
  return EMPTY_SELECTION;
}

/**
 * Resolve a click into a new selection. A plain click selects the hit node
 * (or clears on empty space); an additive click (shift/ctrl) toggles the hit
 * node and leaves empty clicks unchanged.
 */
export function resolveSelectionClick(
  selection: Selection,
  hitId: NodeId | null,
  options: { additive?: boolean }
): Selection {
  if (options.additive) {
    return hitId ? toggleSelection(selection, hitId) : selection;
  }
  return hitId ? selectOnly(selection, hitId) : clearSelection();
}

/** Drop ids that are no longer in `doc` and fix the primary. */
export function pruneSelection(selection: Selection, doc: SceneDocument): Selection {
  const ids = new Set<NodeId>();
  for (const id of selection.ids) {
    if (doc.has(id)) {
      ids.add(id);
    }
  }
  if (ids.size === selection.ids.size) {
    return selection;
  }
  const primary =
    selection.primary && ids.has(selection.primary)
      ? selection.primary
      : lastOrNull(ids, null);
  return { ids, primary };
}

function lastOrNull(ids: ReadonlySet<NodeId>, preferred: NodeId | null): NodeId | null {
  if (preferred !== null) {
    return preferred;
  }
  let last: NodeId | null = null;
  for (const id of ids) {
    last = id;
  }
  return last;
}
