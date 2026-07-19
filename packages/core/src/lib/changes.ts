/**
 * Change records — the atomic diffs the store emits for every mutation.
 *
 * History (undo/redo) and reactivity are both projections of this stream
 * (ADR 0004). A change carries full node snapshots rather than field-level
 * deltas: nodes are small plain records, snapshots are trivially invertible,
 * and — because the store treats nodes as immutable values — a snapshot can
 * never be mutated out from under a change record.
 */

import type { NodeId } from './id';
import type { SceneNode } from './node';

/** A single atomic change to the document's node map. */
export type NodeChange =
  | { readonly op: 'add'; readonly id: NodeId; readonly node: SceneNode }
  | { readonly op: 'remove'; readonly id: NodeId; readonly node: SceneNode }
  | {
      readonly op: 'update';
      readonly id: NodeId;
      readonly before: SceneNode;
      readonly after: SceneNode;
    };

/**
 * A group of changes emitted together (one mutation, or one transaction).
 * A `coalesceKey` lets consecutive change-sets from the same continuous
 * gesture (e.g. a drag) merge into a single undo entry.
 */
export interface ChangeSet {
  readonly changes: readonly NodeChange[];
  readonly coalesceKey?: string;
}

/** The node id a change targets. */
export function changeTarget(change: NodeChange): NodeId {
  return change.id;
}

/** Return the change that exactly undoes `change`. */
export function invertChange(change: NodeChange): NodeChange {
  switch (change.op) {
    case 'add':
      return { op: 'remove', id: change.id, node: change.node };
    case 'remove':
      return { op: 'add', id: change.id, node: change.node };
    case 'update':
      return {
        op: 'update',
        id: change.id,
        before: change.after,
        after: change.before,
      };
    default: {
      const exhaustive: never = change;
      throw new Error(`unknown change op: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Invert a list of changes: reverse order and invert each. */
export function invertChanges(changes: readonly NodeChange[]): NodeChange[] {
  const inverted: NodeChange[] = [];
  for (let i = changes.length - 1; i >= 0; i--) {
    inverted.push(invertChange(changes[i]));
  }
  return inverted;
}
