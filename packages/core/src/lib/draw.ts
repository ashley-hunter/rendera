/**
 * Shape factory for drawing tools — pure builders that turn a gesture's geometry
 * (a drag rectangle, or a list of clicked points) into a `PathNode` input ready
 * to `insert`. DOM/GPU-free and unit-tested; the editor supplies world-space
 * geometry and a style, and inserts the result through history.
 *
 * Each builder centres the geometry in the node's LOCAL space and puts the
 * position in the node's `transform.translation`, so the new node is immediately
 * movable/scalable like any other — its local origin is the top-left of its box
 * (rect/ellipse) or its first point (polyline).
 */

import type { Fill, NodeInput, PathNode, Stroke } from './node';
import { ellipsePath, type FillRule, type Path, polygonPath, rectPath } from './path';
import { vec2, type Vec2 } from './vec2';

/** Paint/stroke to apply to a drawn shape. */
export interface ShapeStyle {
  readonly fill?: Fill;
  readonly stroke?: Stroke;
  readonly fillRule?: FillRule;
}

/** The default paint when a style provides neither fill nor stroke. */
const DEFAULT_FILL: Fill = { type: 'solid', color: { r: 0.42, g: 0.55, b: 0.85, a: 1 } };

const at = (translation: Vec2) => ({
  transform: { translation, rotation: 0, scale: vec2(1, 1), skew: 0, pivot: vec2(0, 0) },
});

/** The min/size of the axis-aligned box spanned by two corner points. */
function box(a: Vec2, b: Vec2): { min: Vec2; w: number; h: number } {
  return { min: vec2(Math.min(a.x, b.x), Math.min(a.y, b.y)), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function pathNode(name: string, translation: Vec2, path: Path, style: ShapeStyle | undefined): NodeInput<PathNode> {
  const hasPaint = style?.fill || style?.stroke;
  return {
    type: 'path',
    name,
    path,
    fill: style?.fill ?? (hasPaint ? undefined : DEFAULT_FILL),
    ...(style?.stroke ? { stroke: style.stroke } : {}),
    ...(style?.fillRule ? { fillRule: style.fillRule } : {}),
    ...at(translation),
  };
}

/** A rectangle spanning the two drag corners `a`–`b`. */
export function rectShape(a: Vec2, b: Vec2, style?: ShapeStyle): NodeInput<PathNode> {
  const { min, w, h } = box(a, b);
  return pathNode('Rectangle', min, rectPath(0, 0, w, h), style);
}

/** An ellipse inscribed in the box spanned by `a`–`b`. */
export function ellipseShape(a: Vec2, b: Vec2, style?: ShapeStyle): NodeInput<PathNode> {
  const { min, w, h } = box(a, b);
  return pathNode('Ellipse', min, ellipsePath(w / 2, h / 2, w / 2, h / 2), style);
}

/**
 * A polyline/polygon through `points` (world space). `closed` makes it a filled
 * polygon; open makes a stroked path. Points are stored relative to the first
 * point, which becomes the node's local origin.
 */
export function polylineShape(points: readonly Vec2[], closed: boolean, style?: ShapeStyle): NodeInput<PathNode> {
  const origin = points[0];
  const local = points.map((p) => vec2(p.x - origin.x, p.y - origin.y));
  const path: Path = closed
    ? polygonPath(local)
    : { subpaths: [{ start: local[0], closed: false, segments: local.slice(1).map((to) => ({ type: 'line', to }) as const) }] };
  return pathNode(closed ? 'Polygon' : 'Path', origin, path, style);
}

/** Whether a two-corner drag is large enough to be a real shape (not a stray click). */
export function isDrawnBigEnough(a: Vec2, b: Vec2, min = 2): boolean {
  const { w, h } = box(a, b);
  return w >= min && h >= min;
}
