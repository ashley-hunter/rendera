/**
 * Transform handles & drag math — the move / scale / rotate geometry an editor
 * needs, as pure functions over a `SceneDocument` (DOM-free, unit-tested).
 *
 * A selection is framed by an **oriented box**: a `Mat2D` mapping the unit square
 * [0,1]² to world space. For a single node it is the node's world matrix over its
 * local bounds, so the box (and its handles) rotate/scale/shear exactly with the
 * shape — scaling a rotated node then stays along the node's own axes, never
 * skewing it. For a multi-selection it is the world-space AABB.
 *
 * `dragTransform` turns a handle drag (a from/to pointer pair, both in world
 * space) into a world-space `Mat2D` delta; `applyTransform` composes that delta
 * into each selected node's local decomposed transform. Keeping the delta in
 * world space means one gesture applies uniformly to a multi-selection.
 */

import type { SceneDocument } from './document';
import { selectionBounds } from './hit-test';
import type { NodeId } from './id';
import {
  compose,
  fromRotation,
  fromScaling,
  fromTranslation,
  IDENTITY,
  invert,
  multiply,
  transformPoint,
  type Mat2D,
} from './matrix';
import type { SpatialNode } from './node';
import { matrixToTransform } from './transform';
import { vec2, type Vec2 } from './vec2';

/** A drag handle: the eight resize grips, the rotate grip, or the body (move). */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate' | 'move';

/** A resize handle's position in the unit box. */
const PARAM: Record<Exclude<HandleId, 'rotate' | 'move'>, Vec2> = {
  nw: vec2(0, 0), n: vec2(0.5, 0), ne: vec2(1, 0), e: vec2(1, 0.5),
  se: vec2(1, 1), s: vec2(0.5, 1), sw: vec2(0, 1), w: vec2(0, 0.5),
};
/** The opposite (anchor) handle — the corner/edge that stays put while scaling. */
const OPPOSITE: Record<Exclude<HandleId, 'rotate' | 'move'>, Exclude<HandleId, 'rotate' | 'move'>> = {
  nw: 'se', ne: 'sw', se: 'nw', sw: 'ne', n: 's', s: 'n', e: 'w', w: 'e',
};
const CONTROLS_X = new Set<HandleId>(['nw', 'ne', 'se', 'sw', 'e', 'w']);
const CONTROLS_Y = new Set<HandleId>(['nw', 'ne', 'se', 'sw', 'n', 's']);

/** A placed handle: its id and world-space point. */
export interface Handle {
  readonly id: HandleId;
  readonly point: Vec2;
}

/** Options for `dragTransform`. */
export interface DragOptions {
  /** Corner resize keeps the box's aspect ratio (shift). */
  readonly uniform?: boolean;
  /** Scale about the box centre instead of the opposite handle (alt). */
  readonly fromCentre?: boolean;
}

/**
 * The selection's oriented frame: a `Mat2D` mapping the unit square to world
 * space. A single node uses its world matrix over its local bounds (so the box
 * is oriented with the node); a multi-selection uses the world AABB. `null` when
 * nothing selectable is given.
 */
export function selectionFrame(doc: SceneDocument, ids: Iterable<NodeId>): Mat2D | null {
  const arr = [...ids];
  if (arr.length === 1) {
    const b = doc.getLocalBounds(arr[0]);
    if (b && b.maxX - b.minX > 1e-6 && b.maxY - b.minY > 1e-6) {
      return compose(
        doc.getWorldMatrix(arr[0]),
        fromTranslation(vec2(b.minX, b.minY)),
        fromScaling(vec2(b.maxX - b.minX, b.maxY - b.minY))
      );
    }
  }
  const b = selectionBounds(doc, arr);
  if (!b || b.maxX - b.minX < 1e-9 || b.maxY - b.minY < 1e-9) return null;
  return compose(fromTranslation(vec2(b.minX, b.minY)), fromScaling(vec2(b.maxX - b.minX, b.maxY - b.minY)));
}

/** The nine handle points for a frame `B` (world space). The rotate grip sits a
 *  fraction of the box height beyond the top-centre edge, along the box's axis. */
export function handles(box: Mat2D): Handle[] {
  const out: Handle[] = (Object.keys(PARAM) as (keyof typeof PARAM)[]).map((id) => ({
    id,
    point: transformPoint(box, PARAM[id]),
  }));
  const topC = transformPoint(box, vec2(0.5, 0));
  const botC = transformPoint(box, vec2(0.5, 1));
  const k = 0.18; // rotate grip offset, as a fraction of box height, above the top
  out.push({ id: 'rotate', point: vec2(topC.x + (topC.x - botC.x) * k, topC.y + (topC.y - botC.y) * k) });
  return out;
}

/** The handle whose world point is within `radius` of `p` (nearest wins), else null. */
export function handleAt(placed: readonly Handle[], p: Vec2, radius: number): HandleId | null {
  let best: HandleId | null = null;
  let bestD = radius * radius;
  for (const h of placed) {
    const d = (h.point.x - p.x) ** 2 + (h.point.y - p.y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = h.id;
    }
  }
  return best;
}

const safeDiv = (a: number, b: number): number => (Math.abs(b) < 1e-9 ? 1 : a / b);
const rotateAbout = (c: Vec2, radians: number): Mat2D =>
  compose(fromTranslation(c), fromRotation(radians), fromTranslation(vec2(-c.x, -c.y)));

/**
 * The world-space transform delta for dragging `handle` from `start` to
 * `current` (both world points) on the frame `box`. Move translates; rotate
 * spins about the box centre; a resize handle scales the box along its own axes
 * about the opposite handle (or the centre with `fromCentre`), keeping aspect
 * with `uniform`.
 */
export function dragTransform(
  box: Mat2D,
  handle: HandleId,
  start: Vec2,
  current: Vec2,
  options: DragOptions = {}
): Mat2D {
  if (handle === 'move') {
    return fromTranslation(vec2(current.x - start.x, current.y - start.y));
  }
  const inv = invert(box);
  if (!inv) return IDENTITY;
  if (handle === 'rotate') {
    const c = transformPoint(box, vec2(0.5, 0.5));
    const a0 = Math.atan2(start.y - c.y, start.x - c.x);
    const a1 = Math.atan2(current.y - c.y, current.x - c.x);
    return rotateAbout(c, a1 - a0);
  }
  const anchor = options.fromCentre ? vec2(0.5, 0.5) : PARAM[OPPOSITE[handle]];
  const ps = transformPoint(inv, start); // grab point, in box param space
  const pc = transformPoint(inv, current);
  let fx = CONTROLS_X.has(handle) ? safeDiv(pc.x - anchor.x, ps.x - anchor.x) : 1;
  let fy = CONTROLS_Y.has(handle) ? safeDiv(pc.y - anchor.y, ps.y - anchor.y) : 1;
  if (options.uniform && CONTROLS_X.has(handle) && CONTROLS_Y.has(handle)) {
    const f = Math.abs(fx) >= Math.abs(fy) ? fx : fy;
    fx = f;
    fy = f;
  }
  const scale = compose(fromTranslation(anchor), fromScaling(vec2(fx, fy)), fromTranslation(vec2(-anchor.x, -anchor.y)));
  return compose(box, scale, inv); // param-space scale, conjugated back to world
}

/**
 * Apply a world-space transform `delta` to each node, composing it into the
 * node's local decomposed transform (respecting the node's parent). Mutates the
 * document (one `update` per node).
 */
export function applyTransform(doc: SceneDocument, ids: Iterable<NodeId>, delta: Mat2D): void {
  for (const id of ids) {
    const node = doc.get(id) as SpatialNode | undefined;
    if (!node || !('transform' in node)) continue;
    const newWorld = multiply(delta, doc.getWorldMatrix(id));
    const parentId = node.parentId;
    const parentWorld = parentId && parentId !== doc.root.id ? doc.getWorldMatrix(parentId) : IDENTITY;
    const newLocal = multiply(invert(parentWorld) ?? IDENTITY, newWorld);
    doc.update(id, { transform: matrixToTransform(newLocal) });
  }
}
