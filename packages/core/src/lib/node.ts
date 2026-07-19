/**
 * Node records.
 *
 * A document is a flat map of these plain, serializable records (ADR 0004).
 * Records hold *data only* — behaviour lives in per-type utils (see
 * `registry.ts`). Hierarchy is encoded as `parentId` plus a fractional
 * `index` order key; the tree is derived, never stored as nested arrays.
 *
 * Nodes that participate in the transform hierarchy are `SpatialNode`s and
 * carry a decomposed `transform` (ADR 0006). The document root is a fixed,
 * non-spatial origin. `transform` and `size` are filled with defaults by the
 * store when omitted from an insert (see the node utils' `createDefaults`).
 */

import type { Transform } from './transform';
import type { OrderKey } from './ordering';
import type { NodeId } from './id';
import type { Vec2 } from './vec2';

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

/** A node that participates in the transform hierarchy. */
export interface SpatialNode extends SceneNode {
  /** Decomposed local transform relative to the parent (ADR 0006). */
  transform: Transform;
}

/** The single, non-spatial root of a document (the coordinate origin). */
export interface DocumentNode extends SceneNode {
  readonly type: 'document';
  parentId: null;
  name: string;
}

/** A container that groups other nodes under a shared transform. */
export interface GroupNode extends SpatialNode {
  readonly type: 'group';
  name: string;
}

/** A leaf content node. Its local geometry is a `size`-sized rectangle until
 * a real raster/vector geometry replaces it in a later phase. */
export interface LayerNode extends SpatialNode {
  readonly type: 'layer';
  name: string;
  /** Local rectangular extent (top-left at the local origin). */
  size: Vec2;
}

/**
 * A leaf raster node: a `size`-sized rectangle textured by an image asset. The
 * pixels live out-of-band in the backend (e.g. a WebGPU texture cache) and are
 * referenced by `assetId` — the model holds only the reference, extent, and
 * opacity, so big binary data never enters the node store, diffs, or undo.
 */
export interface ImageNode extends SpatialNode {
  readonly type: 'image';
  name: string;
  /** Local rectangular extent (top-left at the local origin). */
  size: Vec2;
  /** Opaque handle to the pixel asset, resolved by the renderer. */
  assetId: string;
  /** Layer opacity in [0, 1] (defaults to 1). */
  opacity?: number;
}

/** The built-in node types known to the default registry. */
export type KnownNode = DocumentNode | GroupNode | LayerNode | ImageNode;

/**
 * The fields a caller supplies when inserting a node. `id`/`parentId`/`index`
 * are assigned by the document; `transform`/`size` are optional and default via
 * the node util.
 */
export type NodeInput<N extends SceneNode = SceneNode> = Omit<
  N,
  'id' | 'parentId' | 'index' | 'transform' | 'size'
> &
  Partial<Pick<N, Extract<keyof N, 'transform' | 'size'>>>;
