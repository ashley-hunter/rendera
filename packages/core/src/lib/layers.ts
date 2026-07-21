/**
 * Layers-panel model — the flattened document tree and reorder math a layers UI
 * needs, as pure functions over a `SceneDocument` (DOM-free, unit-tested).
 *
 * `layerRows` walks the tree into a flat, indented row list in **front-to-back**
 * order (the topmost row is the front-most shape — later siblings paint on top,
 * so higher index = more front), honouring a set of collapsed container ids.
 * `moveNode` drops a node above/below/into another and reports whether the move
 * was legal, keeping the panel free of ordering and cycle-guard logic.
 */

import type { SceneDocument } from './document';
import type { NodeId } from './id';
import type { SpatialNode } from './node';

/** One row of the layers panel: a node with its depth, state, and child info. */
export interface LayerRow {
  readonly id: NodeId;
  /** Display label — the node's `name`, falling back to its `type`. */
  readonly name: string;
  readonly type: string;
  /** Indentation level (0 = a top-level node under the document root). */
  readonly depth: number;
  /** Whether the node is drawn (a spatial node's `visible`, default true). */
  readonly visible: boolean;
  /** Whether this type can contain children (a group/boolean/mask). */
  readonly container: boolean;
  /** Whether it actually has any children right now. */
  readonly hasChildren: boolean;
  /** Whether its subtree is collapsed (hidden) in the panel. */
  readonly collapsed: boolean;
}

/** Where a dropped node lands relative to a target row. */
export type DropPlacement = 'above' | 'below' | 'inside';

export interface LayerRowsOptions {
  /** Container ids whose children are hidden in the panel. */
  readonly collapsed?: ReadonlySet<NodeId>;
}

const nameOf = (node: { name?: unknown; type: string }): string =>
  typeof node.name === 'string' && node.name ? node.name : node.type;

/**
 * Flatten the document into indented rows, front-to-back (topmost row = front-
 * most node). A collapsed container contributes its own row but not its subtree.
 */
export function layerRows(doc: SceneDocument, options: LayerRowsOptions = {}): LayerRow[] {
  const collapsed = options.collapsed ?? new Set<NodeId>();
  const rows: LayerRow[] = [];
  const walk = (parentId: NodeId, depth: number): void => {
    // `getChildren` is ascending by index (back-to-front); reverse for the panel.
    const children = doc.getChildren(parentId).slice().reverse();
    for (const node of children) {
      const container = doc.canHaveChildren(node.id);
      const hasChildren = container && doc.getChildren(node.id).length > 0;
      const isCollapsed = collapsed.has(node.id);
      rows.push({
        id: node.id,
        name: nameOf(node as { name?: unknown; type: string }),
        type: node.type,
        depth,
        visible: (node as SpatialNode).visible !== false,
        container,
        hasChildren,
        collapsed: isCollapsed,
      });
      if (hasChildren && !isCollapsed) walk(node.id, depth + 1);
    }
  };
  walk(doc.root.id, 0);
  return rows;
}

/**
 * Move `id` relative to `targetId`: `above`/`below` make them siblings (front/
 * back of the target in z-order), `inside` puts `id` at the front of the target's
 * children. Returns `false` (no change) for an illegal move — dropping onto the
 * document root, onto itself or its own descendant, into a non-container, or when
 * the target is missing.
 */
export function moveNode(doc: SceneDocument, id: NodeId, targetId: NodeId, placement: DropPlacement): boolean {
  if (id === targetId) return false;
  const node = doc.get(id);
  const target = doc.get(targetId);
  if (!node || !target || node.parentId === null) return false;
  // Never move a node into its own subtree (would orphan the branch).
  if (id === targetId || doc.isAncestor(id, targetId)) return false;

  if (placement === 'inside') {
    if (!doc.canHaveChildren(targetId)) return false;
    doc.move(id, { parentId: targetId, position: { at: 'last' } });
    return true;
  }
  if (target.parentId === null) return false; // can't be a sibling of the root
  doc.move(id, {
    parentId: target.parentId,
    position: placement === 'above' ? { at: 'after', id: targetId } : { at: 'before', id: targetId },
  });
  return true;
}
