/**
 * Undo/redo history — a projection of the document's change stream (ADR 0004).
 *
 * History subscribes to the store's change-sets and keeps forward change lists
 * on an undo stack. Undo inverts an entry's changes and applies them; redo
 * re-applies the forward changes. Because it operates on recorded diffs (not
 * bespoke inverse code), correctness follows from the change records alone.
 *
 * Undo units are whole change-sets: one mutation, or one `transaction()`.
 * Change-sets sharing a `coalesceKey` merge into the previous entry, so a
 * continuous gesture (e.g. a drag) collapses to a single undoable step.
 * Applying undo/redo is done with history suspended, so it never records
 * itself; other subscribers (reactivity) still observe the changes.
 */

import { invertChanges, type ChangeSet, type NodeChange } from './changes';
import type { SceneDocument, TransactionOptions } from './document';

interface HistoryEntry {
  changes: NodeChange[];
  coalesceKey?: string;
}

export interface HistoryOptions {
  /** Maximum number of undo entries to retain (oldest are dropped). */
  limit?: number;
}

export class History {
  private readonly doc: SceneDocument;
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private readonly limit: number;
  private readonly dispose: () => void;
  private suspended = false;

  constructor(doc: SceneDocument, options: HistoryOptions = {}) {
    this.doc = doc;
    this.limit = options.limit ?? Number.POSITIVE_INFINITY;
    this.dispose = doc.subscribe((changeSet) => this.record(changeSet));
  }

  /** Whether there is anything to undo. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Whether there is anything to redo. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Number of entries on the undo stack. */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** Number of entries on the redo stack. */
  get redoDepth(): number {
    return this.redoStack.length;
  }

  /** Undo the most recent change-set. Returns false if nothing to undo. */
  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) {
      return false;
    }
    this.apply(invertChanges(entry.changes));
    this.redoStack.push(entry);
    return true;
  }

  /** Redo the most recently undone change-set. Returns false if nothing. */
  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) {
      return false;
    }
    this.apply(entry.changes);
    this.undoStack.push(entry);
    return true;
  }

  /**
   * Group all mutations made by `fn` into a single undo entry (delegates to
   * `document.transaction`). Pass a `coalesceKey` to merge with a preceding
   * same-key entry.
   */
  batch<T>(fn: () => T, options?: TransactionOptions): T {
    return this.doc.transaction(fn, options);
  }

  /** Run `fn` without recording any history (for ephemeral/programmatic edits). */
  withoutHistory<T>(fn: () => T): T {
    const previous = this.suspended;
    this.suspended = true;
    try {
      return fn();
    } finally {
      this.suspended = previous;
    }
  }

  /** Clear both stacks. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Stop listening to the document. */
  destroy(): void {
    this.dispose();
  }

  private record(changeSet: ChangeSet): void {
    if (this.suspended || changeSet.changes.length === 0) {
      return;
    }
    // Any fresh edit invalidates the redo stack.
    this.redoStack.length = 0;

    const previous = this.undoStack[this.undoStack.length - 1];
    if (
      changeSet.coalesceKey !== undefined &&
      previous &&
      previous.coalesceKey === changeSet.coalesceKey
    ) {
      previous.changes.push(...changeSet.changes);
      return;
    }

    this.undoStack.push({
      changes: [...changeSet.changes],
      coalesceKey: changeSet.coalesceKey,
    });
    while (this.undoStack.length > this.limit) {
      this.undoStack.shift();
    }
  }

  private apply(changes: NodeChange[]): void {
    this.suspended = true;
    try {
      this.doc.applyChanges(changes);
    } finally {
      this.suspended = false;
    }
  }
}
