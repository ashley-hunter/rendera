/**
 * Copy & paste — snapshot a selection's subtrees to a portable, serializable
 * value, and paste clones back into a document, as pure functions over a
 * `SceneDocument` (DOM-free, unit-tested).
 *
 * `copyNodes` captures the selection roots (deep, structure preserved) as plain
 * data with the structural keys (id/parent/index) stripped — so the snapshot is
 * JSON-safe and survives across documents or a real system clipboard.
 * `pasteNodes` re-inserts that data under a parent, minting fresh ids and
 * offsetting the top-level copies, and returns the new root ids (for selecting
 * the paste). Pasting is one transaction — one undo step.
 */

import type { SceneDocument } from './document';
import { roots } from './edit-ops';
import type { NodeId } from './id';
import type { NodeInput, SceneNode, SpatialNode } from './node';

/** A captured node: its data (no id/parent/index) plus its captured children. */
export interface ClipNode {
  readonly node: Record<string, unknown>;
  readonly children: ClipNode[];
}

/** A portable snapshot of one or more subtrees. JSON-serializable. */
export interface Clipboard {
  readonly nodes: ClipNode[];
}

function capture(doc: SceneDocument, id: NodeId): ClipNode {
  const node = doc.require(id);
  // Drop structural keys; `insert` re-assigns them. Everything else is data.
  const { id: _id, parentId: _parent, index: _index, ...rest } = node;
  return { node: rest, children: doc.getChildren(id).map((child) => capture(doc, child.id)) };
}

/**
 * Snapshot the selection's roots (descendants of a selected ancestor are folded
 * into that ancestor's capture) into a portable, JSON-safe `Clipboard`. The
 * snapshot is deep-cloned, so later document edits never mutate it.
 */
export function copyNodes(doc: SceneDocument, ids: Iterable<NodeId>): Clipboard {
  const nodes = roots(doc, ids).map((id) => capture(doc, id));
  // A structural clone isolates the snapshot from the live document entirely.
  return JSON.parse(JSON.stringify({ nodes })) as Clipboard;
}

/** Whether a clipboard holds anything pasteable. */
export function clipboardHasContent(clip: Clipboard | null): clip is Clipboard {
  return !!clip && clip.nodes.length > 0;
}

function insertClip(doc: SceneDocument, clip: ClipNode, parentId: NodeId): NodeId {
  const created = doc.insert(clip.node as NodeInput<SceneNode>, { parentId });
  for (const child of clip.children) insertClip(doc, child, created.id);
  return created.id;
}

export interface PasteOptions {
  /** Where to paste (default: the document root). */
  readonly parentId?: NodeId;
  /** Offset applied to each pasted root's translation (default 10, 10). */
  readonly dx?: number;
  readonly dy?: number;
}

/**
 * Paste a clipboard's subtrees under `parentId` (default the document root),
 * minting fresh ids and offsetting each top-level copy by `(dx, dy)`. Returns the
 * new root ids. One undo step.
 */
export function pasteNodes(doc: SceneDocument, clip: Clipboard, options: PasteOptions = {}): NodeId[] {
  if (clip.nodes.length === 0) return [];
  const parentId = options.parentId ?? doc.root.id;
  const dx = options.dx ?? 10;
  const dy = options.dy ?? 10;
  return doc.transaction(() => {
    const out: NodeId[] = [];
    for (const clipNode of clip.nodes) {
      const id = insertClip(doc, clipNode, parentId);
      const node = doc.get(id) as SpatialNode | undefined;
      if (node && 'transform' in node) {
        const t = node.transform;
        doc.update(id, { transform: { ...t, translation: { x: t.translation.x + dx, y: t.translation.y + dy } } });
      }
      out.push(id);
    }
    return out;
  });
}
