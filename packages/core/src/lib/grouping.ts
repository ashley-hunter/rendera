/**
 * Grouping & combining — wrap a selection in a container (a plain group, or a
 * non-destructive boolean), and unwrap it again, as pure functions over a
 * `SceneDocument` (DOM-free, unit-tested).
 *
 * The hard part is preserving world position: reparenting a node changes the
 * ancestor transforms above it, so each command re-bakes the moved node's local
 * transform to keep it pixel-stable on screen. Every command runs in one
 * transaction — one undo step.
 */

import type { BooleanOp } from './boolean';
import type { SceneDocument } from './document';
import { roots } from './edit-ops';
import type { NodeId } from './id';
import { IDENTITY, invert, multiply } from './matrix';
import type { BooleanNode, GroupNode, SceneNode } from './node';
import type { Paint } from './paint';
import { matrixToTransform } from './transform';

/** Move `id` under `newParentId`, re-baking its local transform to hold world. */
function reparentKeepingWorld(
  doc: SceneDocument,
  id: NodeId,
  newParentId: NodeId,
  position?: { at: 'before'; id: NodeId }
): void {
  const oldWorld = doc.getWorldMatrix(id);
  doc.move(id, position ? { parentId: newParentId, position } : { parentId: newParentId });
  const parentWorld = newParentId === doc.root.id ? IDENTITY : doc.getWorldMatrix(newParentId);
  const newLocal = multiply(invert(parentWorld) ?? IDENTITY, oldWorld);
  doc.update(id, { transform: matrixToTransform(newLocal) });
}

/** The selection roots in ascending z-order (back-to-front), and their parent. */
function orderedRoots(doc: SceneDocument, ids: Iterable<NodeId>): { roots: SceneNode[]; parentId: NodeId } {
  const rootIds = roots(doc, ids);
  const nodes = rootIds.map((id) => doc.get(id)).filter((n): n is SceneNode => !!n && n.parentId !== null);
  nodes.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  // Group under the shared parent when the roots agree; otherwise the document root.
  const parents = new Set(nodes.map((n) => n.parentId));
  const parentId = parents.size === 1 ? (nodes[0].parentId as NodeId) : doc.root.id;
  return { roots: nodes, parentId };
}

/**
 * Wrap the selection in a new group (front-most under the roots' shared parent,
 * else the document root), preserving each node's world position and relative
 * z-order. Returns the new group id, or `null` for an empty selection. One step.
 */
export function groupNodes(doc: SceneDocument, ids: Iterable<NodeId>, name = 'Group'): NodeId | null {
  return doc.transaction(() => {
    const { roots: nodes, parentId } = orderedRoots(doc, ids);
    if (nodes.length === 0) return null;
    const group = doc.insert<GroupNode>({ type: 'group', name }, { parentId });
    for (const node of nodes) reparentKeepingWorld(doc, node.id, group.id);
    return group.id;
  });
}

/**
 * Ungroup every selected group: lift its children into the group's parent (world-
 * preserved, in place of the group in z-order) and delete the now-empty group.
 * Non-group ids are ignored. Returns the freed child ids. One step.
 */
export function ungroupNodes(doc: SceneDocument, ids: Iterable<NodeId>): NodeId[] {
  return doc.transaction(() => {
    const freed: NodeId[] = [];
    for (const id of [...ids]) {
      const group = doc.get(id) as GroupNode | undefined;
      if (!group || group.type !== 'group' || group.parentId === null) continue;
      const parentId = group.parentId;
      // Ascending so each "insert before the group" keeps the original order.
      for (const child of doc.getChildren(id)) {
        reparentKeepingWorld(doc, child.id, parentId, { at: 'before', id });
        freed.push(child.id);
      }
      doc.remove(id);
    }
    return freed;
  });
}

/**
 * Combine the selected path/boolean nodes into a non-destructive boolean node
 * under `op`, preserving world position and z-order; the result inherits the
 * front-most operand's fill/stroke. Needs two or more combinable operands, else
 * `null`. The operands stay individually editable inside. One step.
 */
export function makeBoolean(doc: SceneDocument, ids: Iterable<NodeId>, op: BooleanOp): NodeId | null {
  return doc.transaction(() => {
    const { roots: nodes, parentId } = orderedRoots(doc, ids);
    const operands = nodes.filter((n) => n.type === 'path' || n.type === 'boolean');
    if (operands.length < 2) return null;
    const front = operands[operands.length - 1] as { fill?: Paint; fillRule?: unknown; stroke?: unknown };
    const node = doc.insert<BooleanNode>(
      {
        type: 'boolean',
        name: op,
        op,
        fill: front.fill,
        fillRule: front.fillRule as BooleanNode['fillRule'],
        stroke: front.stroke as BooleanNode['stroke'],
      },
      { parentId }
    );
    for (const operand of operands) reparentKeepingWorld(doc, operand.id, node.id);
    return node.id;
  });
}
