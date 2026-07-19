/**
 * Node records.
 *
 * A document is a flat map of these plain, serializable records (ADR 0004).
 * Records hold *data only* — behaviour lives in per-type utils (see
 * `registry.ts`). Hierarchy is encoded as `parentId` plus a fractional
 * `index` order key; the tree is derived, never stored as nested arrays.
 */

import type { NodeId } from './id';
import type { OrderKey } from './ordering';

/** The common shape of every node record. */
export interface SceneNode {
  readonly id: NodeId;
  /** Discriminator selecting the node's util (behaviour) and extra fields. */
  readonly type: string;
  /** Parent node id, or `null` for the single document root. */
  parentId: NodeId | null;
  /** Fractional order key giving this node's position among its siblings. */
  index: OrderKey;
}

/** The single root of a document. */
export interface DocumentNode extends SceneNode {
  readonly type: 'document';
  parentId: null;
  name: string;
}

/** A container that groups other nodes under a shared transform (later). */
export interface GroupNode extends SceneNode {
  readonly type: 'group';
  name: string;
}

/** A leaf content node (raster/vector specifics come in later phases). */
export interface LayerNode extends SceneNode {
  readonly type: 'layer';
  name: string;
}

/** The built-in node types known to the default registry. */
export type KnownNode = DocumentNode | GroupNode | LayerNode;

/** The fields a caller supplies when inserting a node (id/parent/index are
 * assigned by the document). */
export type NodeInput<N extends SceneNode = SceneNode> = Omit<
  N,
  'id' | 'parentId' | 'index'
>;
