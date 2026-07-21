/**
 * Parametric "live shapes" — a small recipe stored alongside a path node so the
 * editor can keep offering shape-specific controls (a rectangle's corner radius,
 * a polygon's side count) after the shape is drawn. The recipe is the source of
 * truth; `shapeToPath` re-derives the concrete `Path` from it whenever a
 * parameter changes. DOM-free and unit-tested.
 *
 * Geometry is authored in the node's LOCAL space with the shape's box top-left at
 * the origin (matching the drawing builders), so a live shape transforms like any
 * other node.
 */

import { polygonPath, roundedRectPath, type Path } from './path';
import { vec2 } from './vec2';

/** A rounded rectangle: its box size and a corner radius (0 = square corners). */
export interface RectShape {
  readonly kind: 'rect';
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

/** A regular polygon centred at (cx, cy) with `sides` vertices on `radius`. */
export interface PolygonShape {
  readonly kind: 'polygon';
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  /** Number of sides (>= 3). */
  readonly sides: number;
  /** Rotation of the first vertex, in radians (0 puts a point straight up). */
  readonly rotation: number;
}

/** A parametric shape recipe. */
export type ShapeSpec = RectShape | PolygonShape;

/** Derive the concrete path for a shape recipe (local space, box at the origin). */
export function shapeToPath(spec: ShapeSpec): Path {
  if (spec.kind === 'rect') {
    return roundedRectPath(0, 0, spec.width, spec.height, Math.max(0, spec.radius));
  }
  const sides = Math.max(3, Math.round(spec.sides));
  const points = [];
  for (let i = 0; i < sides; i++) {
    // Start at the top (−90°) and step clockwise so the shape reads upright.
    const a = spec.rotation - Math.PI / 2 + (i / sides) * Math.PI * 2;
    points.push(vec2(spec.cx + spec.radius * Math.cos(a), spec.cy + spec.radius * Math.sin(a)));
  }
  return polygonPath(points);
}

/** A rect recipe with a changed corner radius (clamped to >= 0). */
export function withRadius(spec: RectShape, radius: number): RectShape {
  return { ...spec, radius: Math.max(0, radius) };
}

/** A polygon recipe with a changed side count (clamped to >= 3). */
export function withSides(spec: PolygonShape, sides: number): PolygonShape {
  return { ...spec, sides: Math.max(3, Math.round(sides)) };
}
