/**
 * Render command stream — a pure projection of the document into a flat,
 * back-to-front list of compositing commands (ADR 0004).
 *
 * Rather than a flat list of quads, the document flattens into a small command
 * stream a compositor can execute with a stack of render targets:
 *
 *   push-group · draw-solid · draw-image · … · pop-group
 *
 * A plain group (opacity 1, Normal blend, not explicitly isolated) is
 * *pass-through*: it emits no push/pop and its children composite straight onto
 * the backdrop. A group only pushes an isolated target when it must composite
 * as a unit (opacity < 1, a non-Normal blend, or `isolate`). Hidden nodes emit
 * nothing. Being pure, this is unit-tested with no GPU.
 */

import { boundsHeight, boundsWidth, type Bounds } from './bounds';
import type { BlendMode } from './blend';
import { worldToScreenMatrix, type Camera } from './camera';
import type { SceneDocument } from './document';
import type { NodeId } from './id';
import { booleanPath, resolveOverlaps } from './boolean';
import { compose, fromScaling, fromTranslation, invert, transformPoint, IDENTITY, type Mat2D } from './matrix';
import type { BooleanNode, Effect, GroupNode, ImageNode, LayerNode, MaskType, PathNode, SpatialNode, Stroke, TextNode } from './node';
import type { Paint } from './paint';
import {
  pathBounds,
  pathEdges,
  toQuadraticPath,
  transformPath,
  type FillRule,
  type Path,
  type PathEdge,
} from './path';
import { strokePath } from './stroke';
import { vec2 } from './vec2';

/** A linear-light RGBA colour, components in [0, 1]. */
export interface LinearRgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Fields shared by every draw command. */
interface DrawBase {
  readonly nodeId: NodeId;
  /** Maps the unit square [0,1]^2 to screen space (logical px): the node's
   * local geometry, world transform, and the camera composed. */
  readonly transform: Mat2D;
  /** Layer opacity in [0, 1]. */
  readonly opacity: number;
  /** Compositing blend mode. */
  readonly blend: BlendMode;
}

/** Paint a flat-coloured quad. */
export interface DrawSolidCommand extends DrawBase {
  readonly op: 'draw-solid';
  /** Resolved linear-light fill colour. */
  readonly color: LinearRgba;
}

/** Paint a textured quad from the backend asset `assetId`. */
export interface DrawImageCommand extends DrawBase {
  readonly op: 'draw-image';
  readonly assetId: string;
}

/**
 * Fill a vector path. Geometry is pre-transformed to screen space with cubics
 * converted to quadratics, ready for analytic coverage rasterization; the
 * backend has no `transform` to apply — the edges are final.
 */
export interface DrawPathCommand {
  readonly op: 'draw-path';
  readonly nodeId: NodeId;
  /** How the coverage is painted: a flat colour or a gradient. Gradient
   * geometry is in the node's local space (see `screenToLocal`). */
  readonly paint: Paint;
  /** Maps a screen-space (logical px) point back to the node's local space, so
   * the backend can evaluate gradient geometry per pixel. Identity for a
   * degenerate transform. */
  readonly screenToLocal: Mat2D;
  readonly fillRule: FillRule;
  readonly opacity: number;
  readonly blend: BlendMode;
  /** Screen-space edges (lines + quadratics). */
  readonly edges: readonly PathEdge[];
  /** Screen-space bounding box of the geometry. */
  readonly bounds: Bounds;
  /**
   * When true, interior pixels are fully covered — only the true outer/inner
   * boundary gets the analytic AA rim, not internal edges. Set for stroke
   * outlines, which are self-overlapping unions of segment quads + joins; the
   * plain distance-to-nearest-edge rim would otherwise "bead" along every
   * internal seam at high zoom.
   */
  readonly hardInterior?: boolean;
}

/** One MSDF glyph quad: a unit-square→screen transform + its atlas UV rect. */
export interface MsdfQuad {
  readonly transform: Mat2D;
  /** Atlas UV rect (u0, v0, u1, v1), 0..1. */
  readonly uv: readonly [number, number, number, number];
}

/** Paint text as MSDF glyph quads sampled from the atlas texture. */
export interface DrawMsdfCommand {
  readonly op: 'draw-msdf';
  readonly nodeId: NodeId;
  /** Resolved linear-light text colour. */
  readonly color: LinearRgba;
  readonly opacity: number;
  readonly blend: BlendMode;
  /** Distance range (spread) in atlas px — the sampler's AA scale. */
  readonly pxRange: number;
  readonly quads: readonly MsdfQuad[];
}

/** A glyph's atlas placement (structurally an `AtlasGlyph`). */
export interface MsdfCell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly plane: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
}

/** Pre-baked MSDF layout for a text node (positioned glyphs + atlas info). */
export interface MsdfNodeLayout {
  readonly glyphs: readonly { readonly originX: number; readonly originY: number; readonly cell: MsdfCell }[];
  readonly fontSize: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly pxRange: number;
  /** Em size (px) the glyphs were baked at in the atlas — used to route to the
   * analytic outline once the glyph is magnified well beyond it. */
  readonly atlasEmPx: number;
}

/** Begin an isolated group: draws until the matching pop target a fresh layer. */
export interface PushGroupCommand {
  readonly op: 'push-group';
  readonly nodeId: NodeId;
  readonly opacity: number;
  readonly blend: BlendMode;
  /**
   * If set, the most recent `pop-mask` target modulates this group's coverage
   * (multiplied into its premultiplied RGBA) before it composites onto the
   * backdrop — `type` selects the mask channel. A clip is emitted as an `alpha`
   * mask whose content is the clip path filled opaque.
   */
  readonly mask?: { readonly type: MaskType };
  /**
   * Non-destructive effects applied to this group's layer (in order) before it
   * composites. Lengths are in screen space (local × the on-screen scale); the
   * compositor scales them to target px. See `ScreenEffect`.
   */
  readonly effects?: readonly ScreenEffect[];
}

/**
 * A render effect with its spatial lengths resolved to screen space. Colour
 * adjustments (brightness/contrast, hue/saturation, levels) are unitless and
 * pass through unchanged (they carry no lengths to scale).
 */
export type ScreenEffect =
  | { readonly type: 'blur'; readonly radius: number }
  | { readonly type: 'drop-shadow'; readonly dx: number; readonly dy: number; readonly radius: number; readonly color: LinearRgba }
  | { readonly type: 'outer-glow'; readonly radius: number; readonly color: LinearRgba }
  | Extract<Effect, { type: 'brightness-contrast' | 'hue-saturation' | 'levels' }>;

/** Resolve an effect's local-space lengths to screen space via the node matrix. */
function toScreenEffect(e: Effect, m: Mat2D): ScreenEffect {
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  if (e.type === 'blur') {
    return { type: 'blur', radius: e.radius * scale };
  }
  if (e.type === 'outer-glow') {
    return { type: 'outer-glow', radius: e.radius * scale, color: e.color };
  }
  if (e.type === 'drop-shadow') {
    return {
      type: 'drop-shadow',
      dx: m.a * e.dx + m.c * e.dy, // offset is a vector: apply the linear part only
      dy: m.b * e.dx + m.d * e.dy,
      radius: e.radius * scale,
      color: e.color,
    };
  }
  return e; // colour adjustments are unitless
}

/** End the current isolated group, compositing it onto the backdrop. */
export interface PopGroupCommand {
  readonly op: 'pop-group';
  readonly nodeId: NodeId;
}

/**
 * Begin a mask source: the enclosed draws render into a dedicated coverage
 * target instead of the current layer. The matching `pop-mask` stashes that
 * target to be consumed by the next masked `push-group`.
 */
export interface PushMaskCommand {
  readonly op: 'push-mask';
  readonly nodeId: NodeId;
}

/** End a mask source, holding its target for the next masked `push-group`. */
export interface PopMaskCommand {
  readonly op: 'pop-mask';
  readonly nodeId: NodeId;
}

/** One compositing command, executed in order. */
export type RenderCommand =
  | DrawSolidCommand
  | DrawImageCommand
  | DrawPathCommand
  | DrawMsdfCommand
  | PushGroupCommand
  | PopGroupCommand
  | PushMaskCommand
  | PopMaskCommand;

/** The fill used for a layer that has none set (opaque mid-grey). */
const DEFAULT_FILL: LinearRgba = { r: 0.5, g: 0.5, b: 0.5, a: 1 };

/**
 * Cache of resolved boolean-node paths, keyed by document then node id. Boolean
 * ops are geometric and expensive; recomputing them every frame while only the
 * camera moves (pan/zoom) would be very slow, so they're keyed by a cheap
 * content signature of the operands and reused until that changes.
 */
const booleanResultCache = new WeakMap<SceneDocument, Map<NodeId, { sig: string; path: Path | null }>>();

/**
 * Cache of camera-INDEPENDENT prepared vector geometry per node: the local-space
 * fill (cubics→quads) and stroke outline, already reduced to edges + bounds.
 * `buildRenderList` runs every frame; without this it re-ran the expensive
 * cubic→quad conversion, `strokePath`, and `pathEdges` on every pan/zoom even
 * though only the camera changed. Keyed by a content signature; each frame we
 * just affine-transform the cached edges to screen (exact for lines/quadratics).
 */
const geometryCache = new WeakMap<SceneDocument, Map<NodeId, GeomEntry>>();

interface PreparedGeom {
  readonly edges: readonly PathEdge[];
  readonly bounds: Bounds;
}
interface GeomEntry {
  sig: string;
  fill: PreparedGeom | null;
  stroke: PreparedGeom | null;
}

/** Cubic→quad tolerance in local units, scaled to the shape so quality is
 * zoom-stable (text is already quadratic, so this is a no-op there). */
function localTolerance(b: Bounds | null): number {
  if (!b) {
    return 0.1;
  }
  const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
  return Math.min(0.5, Math.max(0.02, diag * 0.0004));
}

/** Affine-transform a list of path edges (control points map exactly). */
function transformEdges(edges: readonly PathEdge[], m: Mat2D): PathEdge[] {
  return edges.map((e) => ({
    a: transformPoint(m, e.a),
    b: transformPoint(m, e.b),
    c: transformPoint(m, e.c),
    quad: e.quad,
  }));
}

/** The screen-space AABB of a local AABB under an affine transform. */
function transformBoundsAabb(b: Bounds, m: Mat2D): Bounds {
  const corners = [
    transformPoint(m, vec2(b.minX, b.minY)),
    transformPoint(m, vec2(b.maxX, b.minY)),
    transformPoint(m, vec2(b.minX, b.maxY)),
    transformPoint(m, vec2(b.maxX, b.maxY)),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** A cheap content checksum of a path (changes when any point moves). */
function pathChecksum(p: Path): number {
  let s = 0;
  let n = 1;
  for (const sp of p.subpaths) {
    s += sp.start.x * 31.1 + sp.start.y * 17.7;
    n++;
    for (const seg of sp.segments) {
      n++;
      s += seg.to.x * 13.3 + seg.to.y * 7.7;
      if (seg.type === 'quad') {
        s += seg.control.x * 3.1 + seg.control.y * 5.3;
      } else if (seg.type === 'cubic') {
        s += seg.c1.x * 1.7 + seg.c1.y * 2.9 + seg.c2.x * 3.7 + seg.c2.y * 4.3;
      }
    }
  }
  return s + n * 1000003;
}

/** Options for `buildRenderList`. */
export interface BuildRenderListOptions {
  /**
   * Pre-computed local-space glyph outlines per text node, keyed by node id.
   * Text shaping is async (the font's wasm loads lazily), so it happens
   * out-of-band; a text node with no entry here emits nothing (not yet laid
   * out).
   */
  readonly textPaths?: ReadonlyMap<NodeId, Path>;
  /**
   * Pre-baked MSDF layouts per text node. Takes precedence over `textPaths`
   * (the caller routes small/dense text to MSDF, large/display text to the
   * analytic outline path).
   */
  readonly textMsdf?: ReadonlyMap<NodeId, MsdfNodeLayout>;
}

/** Flatten the drawable nodes of `doc` into a compositing command stream. */
export function buildRenderList(
  doc: SceneDocument,
  camera: Camera,
  options: BuildRenderListOptions = {}
): RenderCommand[] {
  const commands: RenderCommand[] = [];
  const worldToScreen = worldToScreenMatrix(camera);
  // The base screen matrix normally maps world→screen. While emitting a mask's
  // content it is rebased so the mask renders in the masked node's local space.
  let screenBase = worldToScreen;

  let boolCache = booleanResultCache.get(doc);
  if (!boolCache) {
    boolCache = new Map();
    booleanResultCache.set(doc, boolCache);
  }
  let geomCache = geometryCache.get(doc);
  if (!geomCache) {
    geomCache = new Map();
    geometryCache.set(doc, geomCache);
  }

  /** A content signature of a shape/boolean subtree (for cache invalidation). */
  const shapeSig = (nid: NodeId): string => {
    const n = doc.get(nid) as SpatialNode | undefined;
    if (!n || n.visible === false) {
      return 'x';
    }
    if (n.type === 'path') {
      return 'p' + pathChecksum((n as PathNode).path).toFixed(2);
    }
    if (n.type === 'boolean') {
      const parts = doc.getChildren(nid).map((c) => {
        const m = doc.getLocalMatrix(c);
        return `${shapeSig(c.id)}@${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}`;
      });
      return `b${(n as BooleanNode).op}(${parts.join('|')})`;
    }
    return 'x';
  };

  /**
   * Resolve a path or (nested) boolean node to a single exact-curve path in that
   * node's OWN local space. Operands of a boolean are each brought into the
   * boolean's space via their local matrix, then folded left-to-right by its op.
   * Boolean results are cached by content signature (see `booleanResultCache`).
   */
  const resolveShape = (nid: NodeId): Path | null => {
    const n = doc.get(nid) as SpatialNode | undefined;
    if (!n || n.visible === false) {
      return null;
    }
    if (n.type === 'path') {
      return (n as PathNode).path;
    }
    if (n.type === 'boolean') {
      const sig = shapeSig(nid);
      const cached = boolCache.get(nid);
      if (cached && cached.sig === sig) {
        return cached.path;
      }
      const op = (n as BooleanNode).op;
      const parts: Path[] = [];
      for (const child of doc.getChildren(nid)) {
        const shape = resolveShape(child.id);
        if (shape) {
          parts.push(transformPath(shape, doc.getLocalMatrix(child)));
        }
      }
      let result: Path | null = null;
      if (parts.length > 0) {
        result = parts[0];
        for (let i = 1; i < parts.length; i++) {
          result = booleanPath(result, parts[i], op);
        }
      }
      boolCache.set(nid, { sig, path: result });
      return result;
    }
    return null;
  };

  /**
   * Emit fill + stroke draw-path commands for a vector shape given in the
   * node's local space. Shared by path nodes and (shaped) text nodes: transform
   * to screen, convert cubics to quadratics at sub-pixel tolerance, and pass the
   * screen->local matrix so gradient paint evaluates in local space.
   */
  /**
   * Prepare (and cache) the camera-independent local geometry for a shape: fill
   * edges + bounds (cubics→quads), and — stroked in LOCAL space so its outline
   * complexity is bounded by the shape, not the zoom — the stroke edges + bounds.
   */
  const prepareGeom = (id: NodeId, localPath: Path, stroke: Stroke | undefined): GeomEntry => {
    const sig =
      'p' +
      pathChecksum(localPath).toFixed(2) +
      (stroke ? `|s${stroke.width},${stroke.cap ?? ''},${stroke.join ?? ''},${stroke.miterLimit ?? ''}` : '');
    const cached = geomCache.get(id);
    if (cached && cached.sig === sig) {
      return cached;
    }
    const tol = localTolerance(pathBounds(localPath));
    const fillQuads = toQuadraticPath(localPath, tol);
    const fillEdges = pathEdges(fillQuads);
    const fillBounds = pathBounds(fillQuads);
    const fill = fillBounds && fillEdges.length > 0 ? { edges: fillEdges, bounds: fillBounds } : null;

    let strokeGeom: PreparedGeom | null = null;
    if (stroke) {
      // Stroke the shape's *resolved* outline, not the raw contours. Fonts (and
      // hand-drawn art) routinely self-overlap — a glyph's crossbar running back
      // through its body, accent marks over stems — which nonzero fill hides but
      // stroking would ink as spurious seams deep inside the shape. Removing the
      // overlaps first leaves only the visible edge to stroke.
      const strokeSource = resolveOverlaps(localPath);
      // Flatten/round the stroke at the SAME tolerance as the fill. Stroking's
      // default is 5x coarser, which at high zoom shows as faceted edges and
      // chunky (octagonal) round joins — ragged "borders" inside a stroked glyph.
      const outline = strokePath(
        strokeSource,
        {
          width: stroke.width,
          cap: stroke.cap,
          join: stroke.join,
          miterLimit: stroke.miterLimit,
        },
        tol
      );
      const strokeEdges = pathEdges(outline);
      const strokeBounds = pathBounds(outline);
      if (strokeBounds && strokeEdges.length > 0) {
        strokeGeom = { edges: strokeEdges, bounds: strokeBounds };
      }
    }
    const entry: GeomEntry = { sig, fill, stroke: strokeGeom };
    geomCache.set(id, entry);
    return entry;
  };

  /**
   * Emit fill + stroke draw-path commands for a vector shape given in the node's
   * local space. The heavy geometry (cubic→quad conversion, stroking, edge
   * extraction) is cached camera-independently; here we only affine-transform the
   * cached local edges to screen (exact for lines/quadratics) and pass the
   * screen->local matrix so gradient paint evaluates in local space.
   */
  const emitVector = (
    id: NodeId,
    localPath: Path,
    fill: Paint | undefined,
    stroke: Stroke | undefined,
    fillRule: FillRule,
    screenMat: Mat2D,
    opacity: number,
    blend: BlendMode
  ): void => {
    const geom = prepareGeom(id, localPath, stroke);
    const screenToLocal = invert(screenMat) ?? IDENTITY;

    if ((fill || !stroke) && geom.fill) {
      commands.push({
        op: 'draw-path',
        nodeId: id,
        paint: fill ?? { type: 'solid', color: DEFAULT_FILL },
        screenToLocal,
        fillRule,
        opacity,
        blend,
        edges: transformEdges(geom.fill.edges, screenMat),
        bounds: transformBoundsAabb(geom.fill.bounds, screenMat),
      });
    }

    if (stroke && geom.stroke) {
      commands.push({
        op: 'draw-path',
        nodeId: id,
        paint: stroke.paint,
        screenToLocal,
        fillRule: 'nonzero',
        opacity,
        blend,
        edges: transformEdges(geom.stroke.edges, screenMat),
        bounds: transformBoundsAabb(geom.stroke.bounds, screenMat),
        hardInterior: true,
      });
    }
  };

  /** Emit `content`, wrapped in the node's effect, mask, and clip layers. */
  function withLayers(
    id: NodeId,
    node: SpatialNode,
    opacity: number,
    blend: BlendMode,
    content: (opacity: number, blend: BlendMode) => void
  ): void {
    // Wrappers, OUTERMOST first: effects (post-process the finished layer) →
    // soft mask → geometric clip (innermost, closest to the content). The
    // outermost wrapper carries the node's opacity/blend.
    const wrappers: { coverage?: { type: MaskType; emit: () => void }; effects?: readonly ScreenEffect[] }[] = [];

    if (node.effects && node.effects.length > 0) {
      const screenMat = compose(screenBase, doc.getWorldMatrix(id));
      wrappers.push({ effects: node.effects.map((e) => toScreenEffect(e, screenMat)) });
    }

    // Soft mask: render the mask node's content rebased into this node's local
    // space (so a mask def is reusable and positioned relative to the target).
    const maskRef = node.mask;
    const maskNode = maskRef ? (doc.get(maskRef.maskId) as SpatialNode | undefined) : undefined;
    if (maskRef && maskNode && maskNode.type === 'mask' && maskNode.visible !== false) {
      const rebase = compose(
        worldToScreen,
        doc.getWorldMatrix(id),
        invert(doc.getWorldMatrix(maskRef.maskId)) ?? IDENTITY
      );
      wrappers.push({
        coverage: {
          type: maskRef.type ?? 'luminance',
          emit: () => {
            const saved = screenBase;
            screenBase = rebase;
            for (const child of doc.getChildren(maskRef.maskId)) {
              visit(child.id);
            }
            screenBase = saved;
          },
        },
      });
    }

    // Geometric clip: the clip path filled opaque; its analytic-fill alpha is
    // the clip coverage (applied as an alpha mask, intersecting any soft mask).
    if (node.clip) {
      const clip = node.clip;
      const screenMat = compose(screenBase, doc.getWorldMatrix(id));
      wrappers.push({
        coverage: {
          type: 'alpha',
          emit: () =>
            emitVector(id, clip.path, { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, undefined, clip.rule ?? 'nonzero', screenMat, 1, 'normal'),
        },
      });
    }

    if (wrappers.length === 0) {
      content(opacity, blend); // nothing applied (e.g. an invalid mask reference)
      return;
    }
    // Nest one isolated group per wrapper; the OUTERMOST carries opacity/blend.
    wrappers.forEach((w, i) => {
      const op = i === 0 ? opacity : 1;
      const bl = i === 0 ? blend : 'normal';
      if (w.coverage) {
        commands.push({ op: 'push-mask', nodeId: id });
        w.coverage.emit();
        commands.push({ op: 'pop-mask', nodeId: id });
        commands.push({ op: 'push-group', nodeId: id, opacity: op, blend: bl, mask: { type: w.coverage.type } });
      } else {
        commands.push({ op: 'push-group', nodeId: id, opacity: op, blend: bl, effects: w.effects });
      }
    });
    content(1, 'normal');
    for (let i = 0; i < wrappers.length; i++) {
      commands.push({ op: 'pop-group', nodeId: id });
    }
  }

  /** Emit an isolated group (or pass-through) around `emitChildren`. */
  const emitGroup = (group: GroupNode, opacity: number, blend: BlendMode, emitChildren: () => void): void => {
    const isolated = group.isolate === true || opacity < 1 || blend !== 'normal';
    if (isolated) {
      commands.push({ op: 'push-group', nodeId: group.id, opacity, blend });
      emitChildren();
      commands.push({ op: 'pop-group', nodeId: group.id });
    } else {
      emitChildren();
    }
  };

  function visit(id: NodeId): void {
    const node = doc.get(id) as SpatialNode | undefined;
    if (!node || node.visible === false || node.type === 'mask') {
      return; // missing, hidden, or a mask def (only drawn when referenced)
    }
    const opacity = node.opacity ?? 1;
    const blend: BlendMode = node.blendMode ?? 'normal';
    const layered = !!node.clip || !!node.mask || !!(node.effects && node.effects.length > 0);

    if (node.type === 'group') {
      const group = node as GroupNode;
      const emitChildren = (): void => {
        for (const child of doc.getChildren(id)) {
          visit(child.id);
        }
      };
      if (layered) {
        withLayers(id, node, opacity, blend, (op, bl) => emitGroup(group, op, bl, emitChildren));
      } else {
        emitGroup(group, opacity, blend, emitChildren);
      }
      return;
    }

    const emitSelf = (op: number, bl: BlendMode): void => {
      if (node.type === 'path') {
        const path = node as PathNode;
        const screenMat = compose(screenBase, doc.getWorldMatrix(id));
        emitVector(id, path.path, path.fill, path.stroke, path.fillRule ?? 'nonzero', screenMat, op, bl);
        return;
      }

      if (node.type === 'boolean') {
        const bnode = node as BooleanNode;
        // Fold the operands (in this node's local space) into one exact-curve path.
        const local = resolveShape(id);
        if (local && local.subpaths.length > 0) {
          const screenMat = compose(screenBase, doc.getWorldMatrix(id));
          emitVector(id, local, bnode.fill, bnode.stroke, bnode.fillRule ?? 'nonzero', screenMat, op, bl);
        }
        return;
      }

      if (node.type === 'text') {
        const text = node as TextNode;
        const screenMat = compose(screenBase, doc.getWorldMatrix(id));
        const localPath = options.textPaths?.get(id);
        const hasAnalytic = !!localPath && localPath.subpaths.length > 0;

        // Route by on-screen size. MSDF is fast and flawless while the glyph is
        // rendered at up to ~2x its atlas resolution; magnified beyond that its
        // fixed-resolution field shows clash/hook artifacts, so fall back to the
        // exact analytic outline (resolution-independent) when it's available.
        const msdf = options.textMsdf?.get(id);
        const det = screenMat.a * screenMat.d - screenMat.b * screenMat.c;
        const screenScale = Math.sqrt(Math.abs(det)) || 1;
        const zoomedPastMsdf = msdf ? msdf.fontSize * screenScale > msdf.atlasEmPx * 2 : false;

        if (msdf && !(zoomedPastMsdf && hasAnalytic)) {
          let color = DEFAULT_FILL;
          if (text.fill) {
            color = text.fill.type === 'solid' ? text.fill.color : text.fill.stops[0]?.color ?? DEFAULT_FILL;
          }
          const quads: MsdfQuad[] = [];
          for (const g of msdf.glyphs) {
            const left = g.originX + g.cell.plane.left * msdf.fontSize;
            const right = g.originX + g.cell.plane.right * msdf.fontSize;
            // plane bounds are em, Y-up; local space is Y-down (baseline at originY).
            const top = g.originY - g.cell.plane.top * msdf.fontSize;
            const bottom = g.originY - g.cell.plane.bottom * msdf.fontSize;
            const localFromUnit = compose(
              fromTranslation(vec2(left, top)),
              fromScaling(vec2(right - left, bottom - top))
            );
            quads.push({
              transform: compose(screenMat, localFromUnit),
              uv: [
                g.cell.x / msdf.atlasWidth,
                g.cell.y / msdf.atlasHeight,
                (g.cell.x + g.cell.w) / msdf.atlasWidth,
                (g.cell.y + g.cell.h) / msdf.atlasHeight,
              ],
            });
          }
          if (quads.length > 0) {
            commands.push({ op: 'draw-msdf', nodeId: id, color, opacity: op, blend: bl, pxRange: msdf.pxRange, quads });
          }
          return;
        }

        // Analytic outline path (used when magnified past MSDF, or as the only
        // representation for large/stroked text). Shaping is async, so a node with
        // no layout yet simply emits nothing.
        if (localPath && localPath.subpaths.length > 0) {
          emitVector(id, localPath, text.fill, text.stroke, text.fillRule ?? 'nonzero', screenMat, op, bl);
        }
        return;
      }

      const local = doc.getLocalBounds(id);
      if (!local) {
        return;
      }
      // unit square -> local rect -> world -> screen.
      const localFromUnit = compose(
        fromTranslation(vec2(local.minX, local.minY)),
        fromScaling(vec2(boundsWidth(local), boundsHeight(local)))
      );
      const transform = compose(screenBase, doc.getWorldMatrix(id), localFromUnit);

      if (node.type === 'image') {
        const image = node as ImageNode;
        commands.push({ op: 'draw-image', nodeId: id, transform, assetId: image.assetId, opacity: op, blend: bl });
      } else {
        const layer = node as LayerNode;
        const color = layer.fill?.type === 'solid' ? layer.fill.color : DEFAULT_FILL;
        commands.push({ op: 'draw-solid', nodeId: id, transform, color, opacity: op, blend: bl });
      }
    };

    if (layered) {
      withLayers(id, node, opacity, blend, emitSelf);
    } else {
      emitSelf(opacity, blend);
    }
  }

  for (const child of doc.getChildren(doc.root.id)) {
    visit(child.id);
  }
  return commands;
}

/** A deterministic, pleasant debug colour for a node id (linear RGBA). */
export function debugColorForId(id: NodeId): LinearRgba {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = ((hash >>> 0) % 360) / 360;
  const [r, g, b] = hsvToRgb(hue, 0.7, 0.9);
  return { r, g, b, a: 1 };
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}
