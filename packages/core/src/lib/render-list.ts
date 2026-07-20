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
import { booleanPath } from './boolean';
import { compose, fromScaling, fromTranslation, invert, IDENTITY, type Mat2D } from './matrix';
import type { BooleanNode, GroupNode, ImageNode, LayerNode, PathNode, SpatialNode, Stroke, TextNode } from './node';
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
}

/** Begin an isolated group: draws until the matching pop target a fresh layer. */
export interface PushGroupCommand {
  readonly op: 'push-group';
  readonly nodeId: NodeId;
  readonly opacity: number;
  readonly blend: BlendMode;
}

/** End the current isolated group, compositing it onto the backdrop. */
export interface PopGroupCommand {
  readonly op: 'pop-group';
  readonly nodeId: NodeId;
}

/** One compositing command, executed in order. */
export type RenderCommand =
  | DrawSolidCommand
  | DrawImageCommand
  | DrawPathCommand
  | DrawMsdfCommand
  | PushGroupCommand
  | PopGroupCommand;

/** The fill used for a layer that has none set (opaque mid-grey). */
const DEFAULT_FILL: LinearRgba = { r: 0.5, g: 0.5, b: 0.5, a: 1 };

/**
 * Cache of resolved boolean-node paths, keyed by document then node id. Boolean
 * ops are geometric and expensive; recomputing them every frame while only the
 * camera moves (pan/zoom) would be very slow, so they're keyed by a cheap
 * content signature of the operands and reused until that changes.
 */
const booleanResultCache = new WeakMap<SceneDocument, Map<NodeId, { sig: string; path: Path | null }>>();

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

  let boolCache = booleanResultCache.get(doc);
  if (!boolCache) {
    boolCache = new Map();
    booleanResultCache.set(doc, boolCache);
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
    const screenPath = toQuadraticPath(transformPath(localPath, screenMat), 0.1);
    const screenToLocal = invert(screenMat) ?? IDENTITY;

    if (fill || !stroke) {
      const bounds = pathBounds(screenPath);
      const edges = pathEdges(screenPath);
      if (bounds && edges.length > 0) {
        commands.push({
          op: 'draw-path',
          nodeId: id,
          paint: fill ?? { type: 'solid', color: DEFAULT_FILL },
          screenToLocal,
          fillRule,
          opacity,
          blend,
          edges,
          bounds,
        });
      }
    }

    if (stroke) {
      // Stroke in LOCAL space, then transform the outline to screen. The outline
      // complexity is then bounded by the shape's own geometry, not its on-screen
      // size — so a deep zoom no longer explodes the segment/join count (which was
      // both a big perf sink and the source of beading along the stroke). Strokes
      // also scale with the shape under non-uniform transforms, as expected.
      const outline = strokePath(localPath, {
        width: stroke.width,
        cap: stroke.cap,
        join: stroke.join,
        miterLimit: stroke.miterLimit,
      });
      const screenOutline = toQuadraticPath(transformPath(outline, screenMat), 0.1);
      const bounds = pathBounds(screenOutline);
      const edges = pathEdges(screenOutline);
      if (bounds && edges.length > 0) {
        commands.push({
          op: 'draw-path',
          nodeId: id,
          paint: stroke.paint,
          screenToLocal,
          fillRule: 'nonzero',
          opacity,
          blend,
          edges,
          bounds,
          hardInterior: true,
        });
      }
    }
  };

  const visit = (id: NodeId): void => {
    const node = doc.get(id) as SpatialNode | undefined;
    if (!node || node.visible === false) {
      return; // missing, or a hidden node/subtree
    }
    const opacity = node.opacity ?? 1;
    const blend: BlendMode = node.blendMode ?? 'normal';

    if (node.type === 'group') {
      const group = node as GroupNode;
      const isolated = group.isolate === true || opacity < 1 || blend !== 'normal';
      if (isolated) {
        commands.push({ op: 'push-group', nodeId: id, opacity, blend });
        for (const child of doc.getChildren(id)) {
          visit(child.id);
        }
        commands.push({ op: 'pop-group', nodeId: id });
      } else {
        for (const child of doc.getChildren(id)) {
          visit(child.id);
        }
      }
      return;
    }

    if (node.type === 'path') {
      const path = node as PathNode;
      const screenMat = compose(worldToScreen, doc.getWorldMatrix(id));
      emitVector(id, path.path, path.fill, path.stroke, path.fillRule ?? 'nonzero', screenMat, opacity, blend);
      return;
    }

    if (node.type === 'boolean') {
      const bnode = node as BooleanNode;
      // Fold the operands (in this node's local space) into one exact-curve path.
      const local = resolveShape(id);
      if (local && local.subpaths.length > 0) {
        const screenMat = compose(worldToScreen, doc.getWorldMatrix(id));
        emitVector(id, local, bnode.fill, bnode.stroke, bnode.fillRule ?? 'nonzero', screenMat, opacity, blend);
      }
      return;
    }

    if (node.type === 'text') {
      const text = node as TextNode;
      const screenMat = compose(worldToScreen, doc.getWorldMatrix(id));

      // MSDF (small/dense text) takes precedence over the analytic outline path.
      const msdf = options.textMsdf?.get(id);
      if (msdf) {
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
          commands.push({ op: 'draw-msdf', nodeId: id, color, opacity, blend, pxRange: msdf.pxRange, quads });
        }
        return;
      }

      // The shaped, local-space glyph outlines are supplied out-of-band (async
      // shaping). No layout yet -> nothing to draw.
      const localPath = options.textPaths?.get(id);
      if (localPath && localPath.subpaths.length > 0) {
        emitVector(id, localPath, text.fill, text.stroke, text.fillRule ?? 'nonzero', screenMat, opacity, blend);
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
    const transform = compose(worldToScreen, doc.getWorldMatrix(id), localFromUnit);

    if (node.type === 'image') {
      const image = node as ImageNode;
      commands.push({ op: 'draw-image', nodeId: id, transform, assetId: image.assetId, opacity, blend });
    } else {
      const layer = node as LayerNode;
      const color = layer.fill?.type === 'solid' ? layer.fill.color : DEFAULT_FILL;
      commands.push({ op: 'draw-solid', nodeId: id, transform, color, opacity, blend });
    }
  };

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
