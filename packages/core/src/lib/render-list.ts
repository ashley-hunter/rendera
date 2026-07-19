/**
 * Render list — a pure projection of the document into flat draw items.
 *
 * This is the bridge from the model to a renderer (ADR 0004): a framework- and
 * GPU-agnostic function flattens the scene + camera into a list of quads, each
 * with a screen-space transform (unit square -> screen px) and a linear-light
 * colour, in back-to-front draw order. A renderer just uploads and draws the
 * list. Being pure, it is unit-tested with no GPU.
 *
 * Colours are debug colours derived from the node id; a real fill/paint model
 * arrives in a later phase.
 */

import { boundsHeight, boundsWidth } from './bounds';
import { worldToScreenMatrix, type Camera } from './camera';
import type { SceneDocument } from './document';
import type { NodeId } from './id';
import { compose, fromScaling, fromTranslation, type Mat2D } from './matrix';
import type { ImageNode } from './node';
import { vec2 } from './vec2';

/** A linear-light RGBA colour, components in [0, 1]. */
export interface LinearRgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Fields shared by every draw item: a node id and a unit-square -> screen map. */
interface DrawItemBase {
  readonly nodeId: NodeId;
  /** Maps the unit square [0,1]^2 to screen space (logical px): includes the
   * node's local geometry, world transform, and the camera. */
  readonly transform: Mat2D;
}

/** A flat-coloured quad (the debug-fill / solid case). */
export interface QuadDrawItem extends DrawItemBase {
  readonly kind: 'solid';
  /** Linear-light fill colour. */
  readonly color: LinearRgba;
}

/** A textured quad, sampling the backend asset referenced by `assetId`. */
export interface ImageDrawItem extends DrawItemBase {
  readonly kind: 'image';
  /** Opaque handle the renderer resolves to a GPU texture. */
  readonly assetId: string;
  /** Layer opacity in [0, 1]. */
  readonly opacity: number;
}

/** A single item to draw, back-to-front. */
export type RenderItem = QuadDrawItem | ImageDrawItem;

/** Flatten the drawable nodes of `doc` into screen-space draw items via `camera`. */
export function buildRenderList(doc: SceneDocument, camera: Camera): RenderItem[] {
  const items: RenderItem[] = [];
  const worldToScreen = worldToScreenMatrix(camera);

  const visit = (id: NodeId): void => {
    const local = doc.getLocalBounds(id);
    if (local) {
      // unit square -> local rect -> world -> screen.
      const localFromUnit = compose(
        fromTranslation(vec2(local.minX, local.minY)),
        fromScaling(vec2(boundsWidth(local), boundsHeight(local)))
      );
      const transform = compose(worldToScreen, doc.getWorldMatrix(id), localFromUnit);
      const node = doc.get(id);
      if (node?.type === 'image') {
        const image = node as ImageNode;
        items.push({
          kind: 'image',
          nodeId: id,
          transform,
          assetId: image.assetId,
          opacity: image.opacity ?? 1,
        });
      } else {
        items.push({ kind: 'solid', nodeId: id, transform, color: debugColorForId(id) });
      }
    }
    for (const child of doc.getChildren(id)) {
      visit(child.id);
    }
  };
  for (const child of doc.getChildren(doc.root.id)) {
    visit(child.id);
  }
  return items;
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
