/**
 * The document: a flat, serializable, ID-keyed record store (ADR 0004).
 *
 * Nodes live in a `Map<NodeId, SceneNode>`. Hierarchy is derived from each
 * node's `parentId` and fractional `index`, never from nested arrays. This is
 * the authoritative model; rendering, history, and selection are projections
 * of it. The store is deliberately DOM-free and unit-testable in isolation.
 */

import { createIdFactory, type IdFactory, type NodeId } from './id';
import type { DocumentNode, NodeInput, SceneNode } from './node';
import {
  generateKeyBetween,
  validateOrderKey,
  type OrderKey,
} from './ordering';
import { createDefaultRegistry, NodeRegistry } from './registry';

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

/** Current on-disk schema version. Bump + migrate on breaking changes. */
export const DOCUMENT_SCHEMA_VERSION = 1;

const DEFAULT_POSITION: InsertPosition = { at: 'last' };
const STRUCTURAL_KEYS = new Set(['id', 'type', 'parentId', 'index']);

export interface SceneDocumentOptions {
  registry?: NodeRegistry;
  idFactory?: IdFactory;
}

export class SceneDocument {
  private readonly nodes = new Map<NodeId, SceneNode>();
  private readonly registry: NodeRegistry;
  private readonly newId: IdFactory;
  private rootId!: NodeId;

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
      current = current.parentId === null ? undefined : this.getParent(current.id);
    }
    return ancestors;
  }

  /** Whether `maybeAncestorId` is an ancestor of `id`. */
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

  // --- mutations -----------------------------------------------------------

  /** Insert a new node under `parentId` at `position`. Returns the node. */
  insert<N extends SceneNode>(
    input: NodeInput<N>,
    options: { parentId?: NodeId; position?: InsertPosition } = {}
  ): N {
    const parentId = options.parentId ?? this.rootId;
    this.assertCanParent(parentId);
    const index = this.indexForPosition(parentId, options.position ?? DEFAULT_POSITION);
    const node = { ...input, id: this.newId(), parentId, index } as N;
    this.nodes.set(node.id, node);
    return node;
  }

  /** Move a node to a new parent and/or position. */
  move(
    id: NodeId,
    options: { parentId?: NodeId; position?: InsertPosition } = {}
  ): SceneNode {
    const node = this.require(id);
    if (node.parentId === null) {
      throw new Error('cannot move the document root');
    }
    const parentId = options.parentId ?? node.parentId;
    this.assertCanParent(parentId);
    if (parentId === id || this.isAncestor(id, parentId)) {
      throw new Error('cannot move a node into itself or its own descendant');
    }
    node.parentId = parentId;
    node.index = this.indexForPosition(
      parentId,
      options.position ?? DEFAULT_POSITION,
      id
    );
    return node;
  }

  /** Shallow-merge data fields into a node. Structural fields are ignored. */
  update(id: NodeId, patch: Record<string, unknown>): SceneNode {
    const node = this.require(id);
    const target = node as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (STRUCTURAL_KEYS.has(key)) {
        continue;
      }
      target[key] = value;
    }
    return node;
  }

  /** Remove a node and its whole subtree. Returns the removed ids. */
  remove(id: NodeId): NodeId[] {
    const node = this.require(id);
    if (node.parentId === null) {
      throw new Error('cannot remove the document root');
    }
    const removed: NodeId[] = [];
    const visit = (nodeId: NodeId): void => {
      for (const child of this.getChildren(nodeId)) {
        visit(child.id);
      }
      this.nodes.delete(nodeId);
      removed.push(nodeId);
    };
    visit(id);
    return removed;
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

  // --- internals -----------------------------------------------------------

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
        return generateKeyBetween(siblings[i - 1]?.index ?? null, siblings[i].index);
      }
      case 'after': {
        const i = siblings.findIndex((child) => child.id === position.id);
        if (i === -1) {
          throw new Error(`reference node "${position.id}" is not a sibling`);
        }
        return generateKeyBetween(siblings[i].index, siblings[i + 1]?.index ?? null);
      }
      default: {
        const exhaustive: never = position;
        throw new Error(`unknown insert position: ${JSON.stringify(exhaustive)}`);
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
