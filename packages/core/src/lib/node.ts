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

import type { BlendMode } from './blend';
import type { BooleanOp } from './boolean';
import type { Paint } from './paint';
import type { LinearRgba } from './render-list';
import type { FillRule, Path } from './path';
import type { StrokeCap, StrokeJoin } from './stroke';
import type { TextAlign, TextDirection } from './text/layout';
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

/**
 * How a shape is painted: a flat colour or a gradient (linear / radial / conic).
 * A tagged value (see `Paint`) so richer paints slot in behind the same field
 * without a migration.
 */
export type Fill = Paint;

/** A path's outline stroke: paint plus width, cap, join, and miter limit. */
export interface Stroke {
  readonly paint: Fill;
  /** Stroke width in the path's local space. */
  readonly width: number;
  readonly cap?: StrokeCap;
  readonly join?: StrokeJoin;
  readonly miterLimit?: number;
}

/**
 * A geometric clip: the node (and its subtree) renders only inside `path`, an
 * antialiased vector region in the node's LOCAL space. Coverage is the path's
 * analytic fill under `rule` — so a clip is exact and resolution-independent,
 * and composes (intersects) with an outer clip/mask.
 */
export interface ClipPath {
  readonly path: Path;
  readonly rule?: FillRule;
}

/**
 * A non-destructive render effect applied to a node's isolated layer, evaluated
 * at render (never baked). Spatial effects' lengths are in the node's LOCAL
 * space, so they scale with zoom like the vector content; adjustment effects are
 * per-pixel colour transforms (unitless). All operate in linear light.
 */
export type Effect =
  | BlurEffect
  | DropShadowEffect
  | OuterGlowEffect
  | BrightnessContrastEffect
  | HueSaturationEffect
  | LevelsEffect;

/** Gaussian blur of the whole layer; `radius` is the ~3σ extent in local px. */
export interface BlurEffect {
  readonly type: 'blur';
  readonly radius: number;
}

/** A blurred, tinted, offset copy of the layer's silhouette composited behind it. */
export interface DropShadowEffect {
  readonly type: 'drop-shadow';
  readonly dx: number;
  readonly dy: number;
  readonly radius: number;
  readonly color: LinearRgba;
}

/** A blurred, tinted copy of the layer's silhouette composited behind it (a halo). */
export interface OuterGlowEffect {
  readonly type: 'outer-glow';
  readonly radius: number;
  readonly color: LinearRgba;
}

/**
 * Brightness/contrast adjustment. `brightness` adds a linear offset; `contrast`
 * scales around mid-grey. Both default 0 (no change); the usual range is
 * [-1, 1].
 */
export interface BrightnessContrastEffect {
  readonly type: 'brightness-contrast';
  readonly brightness: number;
  readonly contrast: number;
}

/**
 * Hue/saturation/lightness adjustment. `hue` rotates in degrees (luminance-
 * preserving); `saturation` in [-1, 1] (−1 = greyscale); `lightness` in [-1, 1]
 * (mixes toward black/white). Omitted channels default to no change.
 */
export interface HueSaturationEffect {
  readonly type: 'hue-saturation';
  readonly hue?: number;
  readonly saturation?: number;
  readonly lightness?: number;
}

/**
 * Photographic "levels": remap the input range `[inBlack, inWhite]` through a
 * `gamma` curve into the output range `[outBlack, outWhite]` (all in [0, 1],
 * applied per channel). Defaults are the identity (0/1/1/0/1).
 */
export interface LevelsEffect {
  readonly type: 'levels';
  readonly inBlack?: number;
  readonly inWhite?: number;
  readonly gamma?: number;
  readonly outBlack?: number;
  readonly outWhite?: number;
}

/** What a soft mask's value is read from: content luminance (default) or alpha. */
export type MaskType = 'luminance' | 'alpha';

/**
 * A soft mask reference: the node's alpha is modulated by the rendered content
 * of the `mask` node (a `MaskNode`), reduced to a coverage value per pixel via
 * `type`. The mask content is authored in the masked node's coordinate space.
 */
export interface MaskRef {
  readonly maskId: NodeId;
  /** Read the mask value from luminance (default) or alpha. */
  readonly type?: MaskType;
}

/**
 * A node that participates in the transform hierarchy. Also carries the
 * universal compositing properties — every spatial node can be faded
 * (`opacity`), blended (`blendMode`), or hidden (`visible`); all default when
 * omitted (opacity 1, blend `'normal'`, visible `true`).
 */
export interface SpatialNode extends SceneNode {
  /** Decomposed local transform relative to the parent (ADR 0006). */
  transform: Transform;
  /** Layer opacity in [0, 1] (default 1). */
  opacity?: number;
  /** Compositing blend mode (default `'normal'`). */
  blendMode?: BlendMode;
  /** Whether the node (and its subtree) is drawn (default `true`). */
  visible?: boolean;
  /** Restrict rendering to a vector region (intersects any inherited clip). */
  clip?: ClipPath;
  /** Modulate the node's alpha by a mask node's luminance or alpha. */
  mask?: MaskRef;
  /** Non-destructive render effects (blur, drop shadow, glow), applied in order. */
  effects?: readonly Effect[];
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
  /** Force isolated compositing even at opacity 1 / Normal (default false —
   * a plain group is pass-through: its children composite onto the backdrop). */
  isolate?: boolean;
}

/** A leaf content node: a `size`-sized rectangle painted by `fill`. */
export interface LayerNode extends SpatialNode {
  readonly type: 'layer';
  name: string;
  /** Local rectangular extent (top-left at the local origin). */
  size: Vec2;
  /** How the rectangle is painted (default: an opaque mid-grey solid). */
  fill?: Fill;
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
}

/**
 * A vector node: a Bézier `path` painted by `fill` under a winding `fillRule`.
 * Rasterized analytically on the GPU (ADR 0007), so it stays crisp at any zoom.
 */
export interface PathNode extends SpatialNode {
  readonly type: 'path';
  name: string;
  /** Local-space geometry. */
  path: Path;
  /** How the path's interior is painted. Omit for a stroke-only path. */
  fill?: Fill;
  /** Winding rule for the fill (default `'nonzero'`). */
  fillRule?: FillRule;
  /** An optional outline stroke, painted over the fill. */
  stroke?: Stroke;
}

/**
 * A text node: a `text` string laid out with a registered font (`fontId`) and
 * painted like a path. Shaping (HarfBuzz) turns it into glyph outlines that flow
 * through the analytic vector fill, so it's resolution-independent and can carry
 * a solid/gradient fill and a stroke. Layout is computed out-of-band (it's async
 * — the font's wasm loads lazily) and supplied to `buildRenderList`.
 */
export interface TextNode extends SpatialNode {
  readonly type: 'text';
  name: string;
  /** The text to render (`\n` breaks lines). */
  text: string;
  /** Id of a font registered with the layout provider. */
  fontId: string;
  /** Em size in local px. */
  fontSize: number;
  /** How the glyphs are painted (default: opaque mid-grey solid). */
  fill?: Fill;
  /** Winding rule for the fill (default `'nonzero'`). */
  fillRule?: FillRule;
  /** An optional outline stroke, painted over the fill. */
  stroke?: Stroke;
  /** Horizontal alignment (default `left`). */
  align?: TextAlign;
  /** Base paragraph direction (default `auto`). */
  direction?: TextDirection;
  /** Extra advance between glyphs in px. */
  letterSpacing?: number;
  /** Baseline-to-baseline distance in px (default from font metrics). */
  lineHeight?: number;
  /** BCP-47 language for language-specific shaping. */
  language?: string;
  /** OpenType feature toggles, e.g. `['dlig', 'ss01']`. */
  features?: readonly string[];
  /** Wrap width in px; when set, text wraps greedily to fit within it. */
  maxWidth?: number;
  /** Optional explicit block extent for bounds/hit-testing (top-left origin). */
  size?: Vec2;
}

/**
 * A non-destructive boolean node: a container whose child path/boolean operands
 * are combined by `op` (union / intersect / difference / xor) into a single
 * exact-curve path at render time. Operands stay individually editable;
 * `difference`/`xor` fold left-to-right (A − B − C …). Painted like a path.
 */
export interface BooleanNode extends SpatialNode {
  readonly type: 'boolean';
  name: string;
  /** How the operands combine. */
  op: BooleanOp;
  /** How the combined region is painted. */
  fill?: Fill;
  fillRule?: FillRule;
  stroke?: Stroke;
}

/**
 * A mask source: a container whose children are rendered off-screen and reduced
 * to a per-pixel coverage value (luminance or alpha) that modulates whatever
 * node references it via `mask`. Not drawn on its own — it only produces a mask.
 * Its content is any subtree (shapes, gradients, images), so masks can be soft
 * (a gradient fade), hard (a shape), or photographic (an image).
 */
export interface MaskNode extends SpatialNode {
  readonly type: 'mask';
  name: string;
}

/** The built-in node types known to the default registry. */
export type KnownNode =
  | DocumentNode
  | GroupNode
  | LayerNode
  | ImageNode
  | PathNode
  | TextNode
  | BooleanNode
  | MaskNode;

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
