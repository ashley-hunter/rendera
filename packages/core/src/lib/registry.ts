/**
 * Node util registry.
 *
 * Behaviour for each node `type` lives in a `NodeUtil`, looked up by type —
 * never stored on the record itself (ADR 0004). This keeps records plain data
 * and the core open to new node types without touching the store. A util
 * declares whether the type may contain children and whether it is spatial,
 * provides default data for omitted fields, and answers geometry queries
 * (local bounds and local hit-testing). Real raster/vector geometry replaces
 * the built-in rectangle per-type in later phases.
 */

import { boundsFromRect, type Bounds } from './bounds';
import type { ImageNode, LayerNode, PathNode, SceneNode } from './node';
import { pathBounds, pointInPath } from './path';
import { IDENTITY_TRANSFORM } from './transform';
import { type Vec2, ZERO } from './vec2';

/** Behaviour associated with a single node `type`. */
export interface NodeUtil {
  /** The node type this util handles. */
  readonly type: string;
  /** Whether nodes of this type may contain children. */
  canHaveChildren(): boolean;
  /** Whether nodes of this type carry a transform. */
  isSpatial(): boolean;
  /** Default data for fields omitted on insert (e.g. transform, size). */
  createDefaults(): Record<string, unknown>;
  /** Local-space bounds of a node's own geometry, or `null` if it has none
   * (e.g. a container, whose bounds derive from its children). */
  getLocalBounds(node: SceneNode): Bounds | null;
  /** Whether a point in the node's local space is inside its geometry. */
  hitTestLocal(node: SceneNode, pointLocal: Vec2): boolean;
}

/** A mutable lookup of `type` -> `NodeUtil`. */
export class NodeRegistry {
  private readonly utils = new Map<string, NodeUtil>();

  /** Register a util. Throws if the type is already registered. */
  register(util: NodeUtil): this {
    if (this.utils.has(util.type)) {
      throw new Error(`node util already registered for type "${util.type}"`);
    }
    this.utils.set(util.type, util);
    return this;
  }

  /** Look up a util, or `undefined` if the type is unknown. */
  get(type: string): NodeUtil | undefined {
    return this.utils.get(type);
  }

  /** Look up a util, throwing if the type is unknown. */
  require(type: string): NodeUtil {
    const util = this.utils.get(type);
    if (!util) {
      throw new Error(`no node util registered for type "${type}"`);
    }
    return util;
  }

  /** Whether a util exists for `type`. */
  has(type: string): boolean {
    return this.utils.has(type);
  }
}

const documentUtil: NodeUtil = {
  type: 'document',
  canHaveChildren: () => true,
  isSpatial: () => false,
  createDefaults: () => ({}),
  getLocalBounds: () => null,
  hitTestLocal: () => false,
};

const groupUtil: NodeUtil = {
  type: 'group',
  canHaveChildren: () => true,
  isSpatial: () => true,
  createDefaults: () => ({ transform: IDENTITY_TRANSFORM }),
  getLocalBounds: () => null,
  hitTestLocal: () => false,
};

const layerUtil: NodeUtil = {
  type: 'layer',
  canHaveChildren: () => false,
  isSpatial: () => true,
  createDefaults: () => ({ transform: IDENTITY_TRANSFORM, size: ZERO }),
  getLocalBounds: (node) => {
    const { size } = node as LayerNode;
    return boundsFromRect(0, 0, size.x, size.y);
  },
  hitTestLocal: (node, p) => {
    const { size } = node as LayerNode;
    return p.x >= 0 && p.y >= 0 && p.x <= size.x && p.y <= size.y;
  },
};

const imageUtil: NodeUtil = {
  type: 'image',
  canHaveChildren: () => false,
  isSpatial: () => true,
  createDefaults: () => ({ transform: IDENTITY_TRANSFORM, size: ZERO, opacity: 1 }),
  getLocalBounds: (node) => {
    const { size } = node as ImageNode;
    return boundsFromRect(0, 0, size.x, size.y);
  },
  hitTestLocal: (node, p) => {
    const { size } = node as ImageNode;
    return p.x >= 0 && p.y >= 0 && p.x <= size.x && p.y <= size.y;
  },
};

const pathUtil: NodeUtil = {
  type: 'path',
  canHaveChildren: () => false,
  isSpatial: () => true,
  createDefaults: () => ({ transform: IDENTITY_TRANSFORM }),
  getLocalBounds: (node) => pathBounds((node as PathNode).path),
  hitTestLocal: (node, p) => {
    const { path, fillRule } = node as PathNode;
    return pointInPath(path, p, fillRule ?? 'nonzero');
  },
};

/** A registry pre-populated with the built-in node types. */
export function createDefaultRegistry(): NodeRegistry {
  return new NodeRegistry()
    .register(documentUtil)
    .register(groupUtil)
    .register(layerUtil)
    .register(imageUtil)
    .register(pathUtil);
}
