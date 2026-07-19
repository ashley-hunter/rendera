/**
 * Axis-aligned bounding boxes.
 *
 * `Bounds` is an AABB in some coordinate space (`minX/minY` top-left,
 * `maxX/maxY` bottom-right, y-down). Transforming bounds by a matrix returns
 * the AABB of the transformed corners — a conservative box, since a rotated
 * rectangle is no longer axis-aligned.
 */

import { type Mat2D, transformPoint } from './matrix';
import { type Vec2, vec2 } from './vec2';

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function bounds(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): Bounds {
  return { minX, minY, maxX, maxY };
}

/** Bounds from an x/y/width/height rectangle. */
export function boundsFromRect(
  x: number,
  y: number,
  width: number,
  height: number
): Bounds {
  return { minX: x, minY: y, maxX: x + width, maxY: y + height };
}

export function boundsWidth(b: Bounds): number {
  return b.maxX - b.minX;
}

export function boundsHeight(b: Bounds): number {
  return b.maxY - b.minY;
}

export function boundsCenter(b: Bounds): Vec2 {
  return vec2((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
}

/** The four corners: top-left, top-right, bottom-right, bottom-left. */
export function boundsCorners(b: Bounds): [Vec2, Vec2, Vec2, Vec2] {
  return [
    vec2(b.minX, b.minY),
    vec2(b.maxX, b.minY),
    vec2(b.maxX, b.maxY),
    vec2(b.minX, b.maxY),
  ];
}

/** Smallest bounds containing every point. Throws if `points` is empty. */
export function boundsFromPoints(points: readonly Vec2[]): Bounds {
  if (points.length === 0) {
    throw new Error('cannot compute bounds of zero points');
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) {
      minX = p.x;
    }
    if (p.y < minY) {
      minY = p.y;
    }
    if (p.x > maxX) {
      maxX = p.x;
    }
    if (p.y > maxY) {
      maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Smallest bounds containing both `a` and `b`. */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Whether a point lies within the bounds (inclusive of edges). */
export function boundsContainsPoint(b: Bounds, p: Vec2): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

/** Whether two bounds overlap (touching edges count as overlap). */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
  );
}

/** The axis-aligned bounds of `b` after applying `m` to its corners. */
export function transformBounds(m: Mat2D, b: Bounds): Bounds {
  return boundsFromPoints(boundsCorners(b).map((c) => transformPoint(m, c)));
}

export function boundsApproxEquals(a: Bounds, b: Bounds, epsilon = 1e-9): boolean {
  return (
    Math.abs(a.minX - b.minX) <= epsilon &&
    Math.abs(a.minY - b.minY) <= epsilon &&
    Math.abs(a.maxX - b.maxX) <= epsilon &&
    Math.abs(a.maxY - b.maxY) <= epsilon
  );
}
