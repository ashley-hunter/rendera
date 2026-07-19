/**
 * Node util registry.
 *
 * Behaviour for each node `type` lives in a `NodeUtil`, looked up by type —
 * never stored on the record itself (ADR 0004). This keeps records plain data
 * and the core open to new node types without touching the store. Geometry,
 * bounds, and hit-testing utils arrive in later phases; for now a util just
 * declares whether the type may contain children.
 */

import type { SceneNode } from './node';

/** Behaviour associated with a single node `type`. */
export interface NodeUtil<N extends SceneNode = SceneNode> {
  /** The node type this util handles. */
  readonly type: N['type'];
  /** Whether nodes of this type may contain children. */
  canHaveChildren(): boolean;
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

function leafUtil<T extends string>(type: T): NodeUtil<SceneNode & { type: T }> {
  return { type, canHaveChildren: () => false };
}

function containerUtil<T extends string>(
  type: T
): NodeUtil<SceneNode & { type: T }> {
  return { type, canHaveChildren: () => true };
}

/** A registry pre-populated with the built-in node types. */
export function createDefaultRegistry(): NodeRegistry {
  return new NodeRegistry()
    .register(containerUtil('document'))
    .register(containerUtil('group'))
    .register(leafUtil('layer'));
}
