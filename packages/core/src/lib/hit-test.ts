/**
 * Hit-testing and selection geometry — the pointer/geometry primitives an editor
 * needs, as pure functions over a `SceneDocument` (DOM-free, unit-tested).
 *
 * `hitTest` maps a world-space point to the top-most node under it, honouring
 * z-order, per-node transforms, visibility, clips, and the actual painted
 * geometry (a path's fill under its winding rule, and — within a tolerance — its
 * stroke). `selectionBounds` gives the world-space box around a set of nodes, for
 * drawing a selection frame.
 */

import type { Bounds } from './bounds';
import type { NodeId } from './id';
import type { SceneDocument } from './document';
import { invert, transformPoint } from './matrix';
import type { PathNode, SceneNode, SpatialNode } from './node';
import { flattenPath, pointInPath } from './path';
import type { Vec2 } from './vec2';

/** Options for `hitTest`. */
export interface HitTestOptions {
  /**
   * Extra world-space radius around the point that still counts as a hit (a
   * pointer "fuzz", so thin strokes and edges are easy to grab). Default 0.
   */
  readonly tolerance?: number;
  /**
   * `'leaf'` (default) returns the deepest node hit; `'outermost'` returns that
   * node's top-level ancestor (the object directly under the document root) —
   * the usual "click selects the whole group" behaviour.
   */
  readonly select?: 'leaf' | 'outermost';
}

/** Squared distance from `p` to segment `a`–`b`. */
function distSqToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return (p.x - cx) ** 2 + (p.y - cy) ** 2;
}

/** Whether `p` (local space) lies within `reach` of any edge of `path`. */
function nearPath(node: PathNode, p: Vec2, reach: number): boolean {
  if (reach <= 0) return false;
  const r2 = reach * reach;
  for (const poly of flattenPath(node.path, Math.max(0.1, reach * 0.25))) {
    for (let i = 0; i + 1 < poly.length; i++) {
      if (distSqToSegment(p, poly[i], poly[i + 1]) <= r2) return true;
    }
  }
  return false;
}

/** Whether a node's own painted geometry contains the local-space point. */
function contains(doc: SceneDocument, node: SceneNode, local: Vec2, tolerance: number): boolean {
  if (node.type === 'path') {
    const p = node as PathNode;
    if (p.fill && pointInPath(p.path, local, p.fillRule ?? 'nonzero')) return true;
    const reach = (p.stroke ? p.stroke.width / 2 : 0) + tolerance;
    return nearPath(p, local, reach);
  }
  // Groups have no own geometry (hit via their children); document/mask never.
  if (node.type === 'group' || node.type === 'document' || node.type === 'mask') return false;
  // Everything else (layer, image, text, boolean): its local bounding box.
  const b = doc.getLocalBounds(node.id);
  if (!b) return false;
  return (
    local.x >= b.minX - tolerance &&
    local.x <= b.maxX + tolerance &&
    local.y >= b.minY - tolerance &&
    local.y <= b.maxY + tolerance
  );
}

/** The top-level ancestor of `id` (the node whose parent is the document root). */
export function topLevelAncestor(doc: SceneDocument, id: NodeId): NodeId {
  let node = doc.get(id);
  const rootId = doc.root.id;
  while (node && node.parentId && node.parentId !== rootId) {
    node = doc.get(node.parentId);
  }
  return node ? node.id : id;
}

/**
 * The top-most node whose painted geometry lies under `worldPoint`, or `null`.
 * Walks front-to-back (later siblings and deeper nodes are on top).
 */
export function hitTest(doc: SceneDocument, worldPoint: Vec2, options: HitTestOptions = {}): NodeId | null {
  const tolerance = options.tolerance ?? 0;

  const visit = (id: NodeId): NodeId | null => {
    const node = doc.get(id);
    if (!node || node.type === 'mask') return null;
    const sp = node as SpatialNode;
    if (sp.visible === false) return null;

    const world = doc.getWorldMatrix(id);
    const inv = invert(world);
    if (!inv) return null;
    const local = transformPoint(inv, worldPoint);

    // A clip culls the node and its whole subtree outside the clip region.
    if (sp.clip && !pointInPath(sp.clip.path, local, sp.clip.rule ?? 'nonzero')) return null;

    // Children are painted on top of the node's own content — test them first,
    // last sibling (top-most) first.
    const children = doc.getChildren(id);
    for (let i = children.length - 1; i >= 0; i--) {
      const hit = visit(children[i].id);
      if (hit) return hit;
    }
    return contains(doc, node, local, tolerance) ? id : null;
  };

  const children = doc.getChildren(doc.root.id);
  for (let i = children.length - 1; i >= 0; i--) {
    const hit = visit(children[i].id);
    if (hit) return options.select === 'outermost' ? topLevelAncestor(doc, hit) : hit;
  }
  return null;
}

/** Options for `nodesInBox`. */
export interface MarqueeOptions {
  /**
   * `false` (default): a node is picked if its world box *intersects* the
   * marquee (touch-to-select). `true`: only nodes wholly *contained* by the
   * marquee are picked (the stricter "must enclose" rubber-band).
   */
  readonly contained?: boolean;
  /** Include nodes whose `visible` is false (default false — skip hidden). */
  readonly includeHidden?: boolean;
}

/** Whether two axis-aligned boxes overlap (share any area). */
function boxesIntersect(a: Bounds, b: Bounds): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/** Whether `inner` lies wholly within `outer`. */
function boxContains(outer: Bounds, inner: Bounds): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

/**
 * The top-level nodes selected by a marquee (rubber-band) `box` in world space,
 * front-to-back is not implied — ids are returned in document order. By default
 * a node is picked when its world box touches the marquee; pass `contained` to
 * require full enclosure. Hidden nodes and nodes without geometry are skipped.
 */
export function nodesInBox(doc: SceneDocument, box: Bounds, options: MarqueeOptions = {}): NodeId[] {
  const out: NodeId[] = [];
  for (const child of doc.getChildren(doc.root.id)) {
    const sp = child as SpatialNode;
    if (!options.includeHidden && sp.visible === false) continue;
    const b = doc.getWorldBounds(child.id);
    if (!b) continue;
    if (options.contained ? boxContains(box, b) : boxesIntersect(box, b)) out.push(child.id);
  }
  return out;
}

/** The union world-space AABB of the given nodes, or `null` if none has bounds. */
export function selectionBounds(doc: SceneDocument, ids: Iterable<NodeId>): Bounds | null {
  let out: Bounds | null = null;
  for (const id of ids) {
    const b = doc.getWorldBounds(id);
    if (!b) continue;
    out = out
      ? { minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY), maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY) }
      : b;
  }
  return out;
}
