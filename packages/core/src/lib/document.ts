/**
 * The document: a flat, serializable, ID-keyed record store (ADR 0004).
 *
 * Nodes live in a `Map<NodeId, SceneNode>`. Hierarchy is derived from each
 * node's `parentId` and fractional `index`, never from nested arrays. This is
 * the authoritative model; rendering, history, and selection are projections
 * of it. The store is deliberately DOM-free and unit-testable in isolation.
 *
 * Nodes are treated as **immutable values**: a mutation replaces a node with a
 * new object rather than mutating in place. Every mutation is recorded as a
 * `NodeChange` and emitted as a `ChangeSet` to subscribers (history, and later
 * reactivity). Multiple mutations can be grouped atomically with
 * `transaction()`.
 */

import {
  invertChange,
  type ChangeSet,
  type NodeChange,
} from './changes';
import { transformBounds, unionBounds, type Bounds } from './bounds';
import { createIdFactory, type IdFactory, type NodeId } from './id';
import { IDENTITY, invert, multiply, transformPoint, type Mat2D } from './matrix';
import type { DocumentNode, NodeInput, SceneNode, SpatialNode } from './node';
import {
  generateKeyBetween,
  validateOrderKey,
  type OrderKey,
} from './ordering';
import { createDefaultRegistry, NodeRegistry } from './registry';
import { toMatrix } from './transform';
import type { Vec2 } from './vec2';

/** Where to place a node among its parent's children. */
export type InsertPosition =
  | { at: 'first' }
  | { at: 'last' }
  | { at: 'before'; id: NodeId }
  | { at: 'after'; id: NodeId };

/** Serialized form of a document. */
export interface SerializedDocument {
  version: number;
  nodes: SceneNode[];
}

/** A subscriber to the document's change stream. */
export type ChangeListener = (changeSet: ChangeSet) => void;

/** Current on-disk schema version. Bump + migrate on breaking changes. */
export const DOCUMENT_SCHEMA_VERSION = 1;

const DEFAULT_POSITION: InsertPosition = { at: 'last' };
const STRUCTURAL_KEYS = new Set(['id', 'type', 'parentId', 'index']);

export interface SceneDocumentOptions {
  registry?: NodeRegistry;
  idFactory?: IdFactory;
}

export interface TransactionOptions {
  /** Consecutive change-sets sharing this key merge into one undo entry. */
  coalesceKey?: string;
}

export class SceneDocument {
  private readonly nodes = new Map<NodeId, SceneNode>();
  private readonly registry: NodeRegistry;
  private readonly newId: IdFactory;
  private readonly listeners = new Set<ChangeListener>();
  private rootId!: NodeId;

  // Transaction state.
  private buffer: NodeChange[] = [];
  private depth = 0;

  private constructor(registry: NodeRegistry, idFactory: IdFactory) {
    this.registry = registry;
    this.newId = idFactory;
  }

  /** Create a new, empty document with a single `document` root node. */
  static create(
    options: SceneDocumentOptions & { name?: string } = {}
  ): SceneDocument {
    const registry = options.registry ?? createDefaultRegistry();
    const idFactory = options.idFactory ?? createIdFactory();
    const doc = new SceneDocument(registry, idFactory);
    const root: DocumentNode = {
      id: idFactory(),
      type: 'document',
      parentId: null,
      index: generateKeyBetween(null, null),
      name: options.name ?? 'Untitled',
    };
    doc.nodes.set(root.id, root);
    doc.rootId = root.id;
    return doc;
  }

  // --- queries -------------------------------------------------------------

  /** The document root node. */
  get root(): DocumentNode {
    return this.nodes.get(this.rootId) as DocumentNode;
  }

  /** Number of nodes in the document, including the root. */
  get size(): number {
    return this.nodes.size;
  }

  /** Get a node by id, or `undefined`. */
  get(id: NodeId): SceneNode | undefined {
    return this.nodes.get(id);
  }

  /** Get a node by id, throwing if it does not exist. */
  require(id: NodeId): SceneNode {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`no node with id "${id}"`);
    }
    return node;
  }

  /** Whether a node exists. */
  has(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  /** The parent of a node, or `undefined` for the root. */
  getParent(id: NodeId): SceneNode | undefined {
    const parentId = this.require(id).parentId;
    return parentId === null ? undefined : this.nodes.get(parentId);
  }

  /** The children of a node, sorted ascending by fractional index. */
  getChildren(parentId: NodeId): SceneNode[] {
    const children: SceneNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.parentId === parentId) {
        children.push(node);
      }
    }
    children.sort(compareByIndex);
    return children;
  }

  /** Ancestors from the immediate parent up to (and including) the root. */
  getAncestors(id: NodeId): SceneNode[] {
    const ancestors: SceneNode[] = [];
    let current = this.getParent(id);
    while (current) {
      ancestors.push(current);
      current =
        current.parentId === null ? undefined : this.getParent(current.id);
    }
    return ancestors;
  }

  /** Whether `maybeAncestorId` is an ancestor of `id` (assumes acyclic tree). */
  isAncestor(maybeAncestorId: NodeId, id: NodeId): boolean {
    let current = this.get(id)?.parentId ?? null;
    while (current !== null) {
      if (current === maybeAncestorId) {
        return true;
      }
      current = this.nodes.get(current)?.parentId ?? null;
    }
    return false;
  }

  /** Iterate over all nodes (unordered). */
  [Symbol.iterator](): IterableIterator<SceneNode> {
    return this.nodes.values();
  }

  // --- change stream -------------------------------------------------------

  /** Subscribe to the change stream. Returns an unsubscribe function. */
  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Run `fn`, grouping every mutation it makes into a single atomic change-set.
   * If `fn` throws, all changes it made are rolled back and nothing is emitted.
   * Transactions nest; only the outermost one emits.
   */
  transaction<T>(fn: () => T, options: TransactionOptions = {}): T {
    const outermost = this.depth === 0;
    this.depth++;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.depth--;
      if (outermost) {
        for (let i = this.buffer.length - 1; i >= 0; i--) {
          this.applyToMap(invertChange(this.buffer[i]));
        }
        this.buffer = [];
      }
      throw error;
    }
    this.depth--;
    if (outermost && this.buffer.length > 0) {
      const changes = this.buffer;
      this.buffer = [];
      this.emit({ changes, coalesceKey: options.coalesceKey });
    }
    return result;
  }

  /**
   * Apply externally-produced changes directly (bypassing validation) and emit
   * them as one change-set. Low-level: used by history undo/redo and future
   * replay/multiplayer. Prefer the mutation methods for authoring.
   */
  applyChanges(
    changes: readonly NodeChange[],
    options: TransactionOptions = {}
  ): void {
    if (changes.length === 0) {
      return;
    }
    for (const change of changes) {
      this.applyToMap(change);
    }
    this.emit({ changes: [...changes], coalesceKey: options.coalesceKey });
  }

  // --- mutations -----------------------------------------------------------

  /** Insert a new node under `parentId` at `position`. Returns the node. */
  insert<N extends SceneNode>(
    input: NodeInput<N>,
    options: { parentId?: NodeId; position?: InsertPosition } = {}
  ): N {
    return this.transaction(() => {
      const parentId = options.parentId ?? this.rootId;
      this.assertCanParent(parentId);
      const index = this.indexForPosition(
        parentId,
        options.position ?? DEFAULT_POSITION
      );
      const defaults = this.registry.require(input.type).createDefaults();
      const node = {
        ...defaults,
        ...input,
        id: this.newId(),
        parentId,
        index,
      } as unknown as N;
      this.commit({ op: 'add', id: node.id, node });
      return node;
    });
  }

  /** Move a node to a new parent and/or position. Returns the new node. */
  move(
    id: NodeId,
    options: { parentId?: NodeId; position?: InsertPosition } = {}
  ): SceneNode {
    return this.transaction(() => {
      const node = this.require(id);
      if (node.parentId === null) {
        throw new Error('cannot move the document root');
      }
      const parentId = options.parentId ?? node.parentId;
      this.assertCanParent(parentId);
      if (parentId === id || this.isAncestor(id, parentId)) {
        throw new Error('cannot move a node into itself or its own descendant');
      }
      const index = this.indexForPosition(
        parentId,
        options.position ?? DEFAULT_POSITION,
        id
      );
      const after: SceneNode = { ...node, parentId, index };
      this.commit({ op: 'update', id, before: node, after });
      return after;
    });
  }

  /** Shallow-merge data fields into a node. Structural fields are ignored. */
  update(id: NodeId, patch: Record<string, unknown>): SceneNode {
    return this.transaction(() => {
      const before = this.require(id);
      const after = { ...before } as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (STRUCTURAL_KEYS.has(key)) {
          continue;
        }
        after[key] = value;
      }
      const afterNode = after as unknown as SceneNode;
      this.commit({ op: 'update', id, before, after: afterNode });
      return afterNode;
    });
  }

  /** Remove a node and its whole subtree. Returns the removed ids. */
  remove(id: NodeId): NodeId[] {
    return this.transaction(() => {
      const node = this.require(id);
      if (node.parentId === null) {
        throw new Error('cannot remove the document root');
      }
      const removed: NodeId[] = [];
      const visit = (nodeId: NodeId): void => {
        for (const child of this.getChildren(nodeId)) {
          visit(child.id);
        }
        this.commit({ op: 'remove', id: nodeId, node: this.require(nodeId) });
        removed.push(nodeId);
      };
      visit(id);
      return removed;
    });
  }

  // --- serialization -------------------------------------------------------

  /** Serialize to a plain, JSON-safe object. */
  toJSON(): SerializedDocument {
    return {
      version: DOCUMENT_SCHEMA_VERSION,
      nodes: [...this.nodes.values()].map((node) => ({ ...node })),
    };
  }

  /** Rebuild a document from serialized data. */
  static fromJSON(
    data: SerializedDocument,
    options: SceneDocumentOptions = {}
  ): SceneDocument {
    if (data.version !== DOCUMENT_SCHEMA_VERSION) {
      throw new Error(
        `unsupported document version ${data.version} (expected ${DOCUMENT_SCHEMA_VERSION})`
      );
    }
    const registry = options.registry ?? createDefaultRegistry();
    const idFactory = options.idFactory ?? createIdFactory();
    const doc = new SceneDocument(registry, idFactory);
    let root: SceneNode | undefined;
    for (const node of data.nodes) {
      if (doc.nodes.has(node.id)) {
        throw new Error(`duplicate node id "${node.id}"`);
      }
      validateOrderKey(node.index);
      doc.nodes.set(node.id, { ...node });
      if (node.parentId === null) {
        if (root) {
          throw new Error('document has more than one root node');
        }
        root = node;
      }
    }
    if (!root) {
      throw new Error('document has no root node');
    }
    doc.rootId = root.id;
    doc.validateIntegrity();
    return doc;
  }

  // --- spatial queries -----------------------------------------------------

  /** The node's local-to-parent matrix (identity for non-spatial nodes). */
  getLocalMatrix(node: SceneNode): Mat2D {
    return this.registry.require(node.type).isSpatial()
      ? toMatrix((node as SpatialNode).transform)
      : IDENTITY;
  }

  /** The node's local-to-world matrix, composing all ancestor transforms. */
  getWorldMatrix(id: NodeId): Mat2D {
    const node = this.require(id);
    let world: Mat2D = IDENTITY;
    for (const ancestor of this.getAncestors(id).reverse()) {
      world = multiply(world, this.getLocalMatrix(ancestor));
    }
    return multiply(world, this.getLocalMatrix(node));
  }

  /** The node's own local-space geometry bounds, or `null` if it has none. */
  getLocalBounds(id: NodeId): Bounds | null {
    const node = this.require(id);
    return this.registry.require(node.type).getLocalBounds(node);
  }

  /**
   * The node's world-space axis-aligned bounds. Leaf geometry is transformed
   * into world space; a container's bounds are the union of its children's.
   * Returns `null` when the node (and its subtree) has no geometry.
   */
  getWorldBounds(id: NodeId): Bounds | null {
    const node = this.require(id);
    const parentWorld =
      node.parentId === null ? IDENTITY : this.getWorldMatrix(node.parentId);
    return this.worldBoundsWithin(node, parentWorld);
  }

  // The parent's world matrix is threaded through the recursion so a subtree
  // walk composes each node's local matrix onto its parent once, instead of
  // re-walking to the root per node. (A dirty-tracked world-matrix cache and a
  // children index are deferred; see docs/ROADMAP.md.)
  private worldBoundsWithin(node: SceneNode, parentWorld: Mat2D): Bounds | null {
    const world = multiply(parentWorld, this.getLocalMatrix(node));
    const local = this.registry.require(node.type).getLocalBounds(node);
    if (local) {
      return transformBounds(world, local);
    }
    let result: Bounds | null = null;
    for (const child of this.getChildren(node.id)) {
      const childBounds = this.worldBoundsWithin(child, world);
      if (childBounds) {
        result = result ? unionBounds(result, childBounds) : childBounds;
      }
    }
    return result;
  }

  /**
   * The top-most node whose geometry contains `point` (in world space), or
   * `undefined`. Walks siblings front-to-back (highest index first) and
   * children before their parent.
   */
  hitTest(point: Vec2): SceneNode | undefined {
    return this.hitTestWithin(this.root, IDENTITY, point);
  }

  private hitTestWithin(
    node: SceneNode,
    parentWorld: Mat2D,
    point: Vec2
  ): SceneNode | undefined {
    const world = multiply(parentWorld, this.getLocalMatrix(node));
    const children = this.getChildren(node.id);
    for (let i = children.length - 1; i >= 0; i--) {
      const hit = this.hitTestWithin(children[i], world, point);
      if (hit) {
        return hit;
      }
    }
    const inverse = invert(world);
    if (inverse) {
      const local = transformPoint(inverse, point);
      if (this.registry.require(node.type).hitTestLocal(node, local)) {
        return node;
      }
    }
    return undefined;
  }

  // --- internals -----------------------------------------------------------

  /** Record a change into the active transaction and apply it to the map. */
  private commit(change: NodeChange): void {
    this.applyToMap(change);
    this.buffer.push(change);
  }

  /** Apply a change to the node map only (no recording, no emit). */
  private applyToMap(change: NodeChange): void {
    switch (change.op) {
      case 'add':
        this.nodes.set(change.id, change.node);
        return;
      case 'remove':
        this.nodes.delete(change.id);
        return;
      case 'update':
        this.nodes.set(change.id, change.after);
        return;
      default: {
        const exhaustive: never = change;
        throw new Error(`unknown change op: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private emit(changeSet: ChangeSet): void {
    for (const listener of this.listeners) {
      listener(changeSet);
    }
  }

  private assertCanParent(parentId: NodeId): void {
    const parent = this.require(parentId);
    if (!this.registry.require(parent.type).canHaveChildren()) {
      throw new Error(`node type "${parent.type}" cannot have children`);
    }
  }

  private indexForPosition(
    parentId: NodeId,
    position: InsertPosition,
    excludeId?: NodeId
  ): OrderKey {
    const siblings = this.getChildren(parentId).filter(
      (child) => child.id !== excludeId
    );
    switch (position.at) {
      case 'first':
        return generateKeyBetween(null, siblings[0]?.index ?? null);
      case 'last':
        return generateKeyBetween(siblings.at(-1)?.index ?? null, null);
      case 'before': {
        const i = siblings.findIndex((child) => child.id === position.id);
        if (i === -1) {
          throw new Error(`reference node "${position.id}" is not a sibling`);
        }
        return generateKeyBetween(
          siblings[i - 1]?.index ?? null,
          siblings[i].index
        );
      }
      case 'after': {
        const i = siblings.findIndex((child) => child.id === position.id);
        if (i === -1) {
          throw new Error(`reference node "${position.id}" is not a sibling`);
        }
        return generateKeyBetween(
          siblings[i].index,
          siblings[i + 1]?.index ?? null
        );
      }
      default: {
        const exhaustive: never = position;
        throw new Error(
          `unknown insert position: ${JSON.stringify(exhaustive)}`
        );
      }
    }
  }

  private validateIntegrity(): void {
    for (const node of this.nodes.values()) {
      if (node.parentId !== null && !this.nodes.has(node.parentId)) {
        throw new Error(
          `node "${node.id}" references missing parent "${node.parentId}"`
        );
      }
    }
    // Every node must reach a root by walking parents. A step cap larger than
    // the node count makes cycle detection terminate on malformed input.
    const limit = this.nodes.size + 1;
    for (const node of this.nodes.values()) {
      let current: NodeId | null = node.parentId;
      let steps = 0;
      while (current !== null) {
        if (steps++ > limit) {
          throw new Error(`node "${node.id}" is part of a parent cycle`);
        }
        current = this.nodes.get(current)?.parentId ?? null;
      }
    }
  }
}

function compareByIndex(a: SceneNode, b: SceneNode): number {
  return a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
}
