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
import { compose, fromScaling, fromTranslation, invert, IDENTITY, type Mat2D } from './matrix';
import type { GroupNode, ImageNode, LayerNode, PathNode, SpatialNode, Stroke, TextNode } from './node';
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
  | PushGroupCommand
  | PopGroupCommand;

/** The fill used for a layer that has none set (opaque mid-grey). */
const DEFAULT_FILL: LinearRgba = { r: 0.5, g: 0.5, b: 0.5, a: 1 };

/** Options for `buildRenderList`. */
export interface BuildRenderListOptions {
  /**
   * Pre-computed local-space glyph outlines per text node, keyed by node id.
   * Text shaping is async (the font's wasm loads lazily), so it happens
   * out-of-band; a text node with no entry here emits nothing (not yet laid
   * out).
   */
  readonly textPaths?: ReadonlyMap<NodeId, Path>;
}

/** Flatten the drawable nodes of `doc` into a compositing command stream. */
export function buildRenderList(
  doc: SceneDocument,
  camera: Camera,
  options: BuildRenderListOptions = {}
): RenderCommand[] {
  const commands: RenderCommand[] = [];
  const worldToScreen = worldToScreenMatrix(camera);

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
      const det = screenMat.a * screenMat.d - screenMat.b * screenMat.c;
      const scaleFactor = Math.sqrt(Math.abs(det)) || 1;
      const outline = strokePath(screenPath, {
        width: stroke.width * scaleFactor,
        cap: stroke.cap,
        join: stroke.join,
        miterLimit: stroke.miterLimit,
      });
      const bounds = pathBounds(outline);
      const edges = pathEdges(outline);
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

    if (node.type === 'text') {
      const text = node as TextNode;
      // The shaped, local-space glyph outlines are supplied out-of-band (async
      // shaping). No layout yet -> nothing to draw.
      const localPath = options.textPaths?.get(id);
      if (localPath && localPath.subpaths.length > 0) {
        const screenMat = compose(worldToScreen, doc.getWorldMatrix(id));
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
