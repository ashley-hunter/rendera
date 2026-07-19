/**
 * Vector path model (ADR 0007).
 *
 * A `Path` is a list of subpaths; each subpath is an on-curve start point plus a
 * sequence of segments (line / quadratic / cubic) and a closed flag. The model
 * authors full SVG-style geometry; the backend rasterizes quadratics and lines
 * exactly, so cubics are converted to quadratics (`toQuadraticPath`) to a
 * sub-pixel tolerance before rasterization — curve-accurate, never straight-line
 * flattening. Everything here is pure and DOM/GPU-free.
 */

import type { Bounds } from './bounds';
import { boundsFromPoints } from './bounds';
import type { Mat2D } from './matrix';
import { transformPoint } from './matrix';
import { add, lerp, scale, vec2, type Vec2 } from './vec2';

export type PathSegment =
  | { readonly type: 'line'; readonly to: Vec2 }
  | { readonly type: 'quad'; readonly control: Vec2; readonly to: Vec2 }
  | { readonly type: 'cubic'; readonly c1: Vec2; readonly c2: Vec2; readonly to: Vec2 };

export interface SubPath {
  readonly start: Vec2;
  readonly segments: readonly PathSegment[];
  readonly closed: boolean;
}

export interface Path {
  readonly subpaths: readonly SubPath[];
}

/** Winding fill rule. */
export type FillRule = 'nonzero' | 'evenodd';

/** A rasterizer edge: a line (`a`→`c`) or a quadratic (`a`, control `b`, `c`). */
export interface PathEdge {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly c: Vec2;
  readonly quad: boolean;
}

// --- construction -----------------------------------------------------------

/** An axis-aligned rectangle. */
export function rectPath(x: number, y: number, w: number, h: number): Path {
  return {
    subpaths: [
      {
        start: vec2(x, y),
        closed: true,
        segments: [
          { type: 'line', to: vec2(x + w, y) },
          { type: 'line', to: vec2(x + w, y + h) },
          { type: 'line', to: vec2(x, y + h) },
        ],
      },
    ],
  };
}

/** A closed polygon through `points`. */
export function polygonPath(points: readonly Vec2[]): Path {
  if (points.length < 2) {
    return { subpaths: [] };
  }
  return {
    subpaths: [
      {
        start: points[0],
        closed: true,
        segments: points.slice(1).map((to) => ({ type: 'line', to }) as const),
      },
    ],
  };
}

/** Kappa: control-point distance for a circular quarter arc as a cubic. */
const KAPPA = 0.5522847498307936;

/** An axis-aligned ellipse centred at (cx,cy), four cubic quarter-arcs. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): Path {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  const right = vec2(cx + rx, cy);
  const bottom = vec2(cx, cy + ry);
  const left = vec2(cx - rx, cy);
  const top = vec2(cx, cy - ry);
  return {
    subpaths: [
      {
        start: right,
        closed: true,
        segments: [
          { type: 'cubic', c1: vec2(cx + rx, cy + oy), c2: vec2(cx + ox, cy + ry), to: bottom },
          { type: 'cubic', c1: vec2(cx - ox, cy + ry), c2: vec2(cx - rx, cy + oy), to: left },
          { type: 'cubic', c1: vec2(cx - rx, cy - oy), c2: vec2(cx - ox, cy - ry), to: top },
          { type: 'cubic', c1: vec2(cx + ox, cy - ry), c2: vec2(cx + rx, cy - oy), to: right },
        ],
      },
    ],
  };
}

/** A rectangle with uniform corner radius `r` (clamped to half the shorter side). */
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): Path {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) {
    return rectPath(x, y, w, h);
  }
  const k = rr * KAPPA;
  const x1 = x + w;
  const y1 = y + h;
  return {
    subpaths: [
      {
        start: vec2(x + rr, y),
        closed: true,
        segments: [
          { type: 'line', to: vec2(x1 - rr, y) },
          { type: 'cubic', c1: vec2(x1 - rr + k, y), c2: vec2(x1, y + rr - k), to: vec2(x1, y + rr) },
          { type: 'line', to: vec2(x1, y1 - rr) },
          { type: 'cubic', c1: vec2(x1, y1 - rr + k), c2: vec2(x1 - rr + k, y1), to: vec2(x1 - rr, y1) },
          { type: 'line', to: vec2(x + rr, y1) },
          { type: 'cubic', c1: vec2(x + rr - k, y1), c2: vec2(x, y1 - rr + k), to: vec2(x, y1 - rr) },
          { type: 'line', to: vec2(x, y + rr) },
          { type: 'cubic', c1: vec2(x, y + rr - k), c2: vec2(x + rr - k, y), to: vec2(x + rr, y) },
        ],
      },
    ],
  };
}

// --- transforms & conversion ------------------------------------------------

/** Apply an affine transform to every point of `path`. */
export function transformPath(path: Path, m: Mat2D): Path {
  const p = (v: Vec2): Vec2 => transformPoint(m, v);
  return {
    subpaths: path.subpaths.map((sub) => ({
      start: p(sub.start),
      closed: sub.closed,
      segments: sub.segments.map((seg) => {
        switch (seg.type) {
          case 'line':
            return { type: 'line', to: p(seg.to) };
          case 'quad':
            return { type: 'quad', control: p(seg.control), to: p(seg.to) };
          default:
            return { type: 'cubic', c1: p(seg.c1), c2: p(seg.c2), to: p(seg.to) };
        }
      }),
    })),
  };
}

/** Split a cubic at `t` (de Casteljau), returning the two control polygons. */
function splitCubic(
  p0: Vec2,
  c1: Vec2,
  c2: Vec2,
  p1: Vec2,
  t: number
): [[Vec2, Vec2, Vec2, Vec2], [Vec2, Vec2, Vec2, Vec2]] {
  const a = lerp(p0, c1, t);
  const b = lerp(c1, c2, t);
  const c = lerp(c2, p1, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const f = lerp(d, e, t);
  return [
    [p0, a, d, f],
    [f, e, c, p1],
  ];
}

/** Approximate a cubic with quadratics to within `tol`, appended to `out`. */
function cubicToQuads(
  p0: Vec2,
  c1: Vec2,
  c2: Vec2,
  p1: Vec2,
  tol: number,
  out: { control: Vec2; to: Vec2 }[],
  depth = 0
): void {
  // Error of a single-quad approximation is bounded by the third difference
  // |p0 - 3c1 + 3c2 - p1| * sqrt(3)/36.
  const dx = p0.x - 3 * c1.x + 3 * c2.x - p1.x;
  const dy = p0.y - 3 * c1.y + 3 * c2.y - p1.y;
  const error = (Math.sqrt(dx * dx + dy * dy) * Math.sqrt(3)) / 36;
  if (error <= tol || depth >= 12) {
    // Single quad: control = (3c1 + 3c2 - p0 - p1) / 4.
    const control = scale(add(add(scale(c1, 3), scale(c2, 3)), scale(add(p0, p1), -1)), 0.25);
    out.push({ control, to: p1 });
    return;
  }
  const [left, right] = splitCubic(p0, c1, c2, p1, 0.5);
  cubicToQuads(left[0], left[1], left[2], left[3], tol, out, depth + 1);
  cubicToQuads(right[0], right[1], right[2], right[3], tol, out, depth + 1);
}

/** A path with every cubic replaced by quadratics within `tol` (default 0.1). */
export function toQuadraticPath(path: Path, tol = 0.1): Path {
  return {
    subpaths: path.subpaths.map((sub) => {
      const segments: PathSegment[] = [];
      let cursor = sub.start;
      for (const seg of sub.segments) {
        if (seg.type === 'cubic') {
          const quads: { control: Vec2; to: Vec2 }[] = [];
          cubicToQuads(cursor, seg.c1, seg.c2, seg.to, tol, quads);
          for (const q of quads) {
            segments.push({ type: 'quad', control: q.control, to: q.to });
          }
          cursor = seg.to;
        } else {
          segments.push(seg);
          cursor = seg.to;
        }
      }
      return { start: sub.start, closed: sub.closed, segments };
    }),
  };
}

/**
 * Flatten a quadratic/line path (no cubics) into rasterizer edges. Fills always
 * close each subpath, so a trailing edge back to the start is emitted.
 */
export function pathEdges(path: Path): PathEdge[] {
  const edges: PathEdge[] = [];
  for (const sub of path.subpaths) {
    let cursor = sub.start;
    for (const seg of sub.segments) {
      if (seg.type === 'quad') {
        edges.push({ a: cursor, b: seg.control, c: seg.to, quad: true });
      } else if (seg.type === 'line') {
        edges.push({ a: cursor, b: seg.to, c: seg.to, quad: false });
      } else {
        // A cubic slipped through un-converted: treat its chord as a line.
        edges.push({ a: cursor, b: seg.to, c: seg.to, quad: false });
      }
      cursor = seg.to;
    }
    // Close the fill.
    if (cursor.x !== sub.start.x || cursor.y !== sub.start.y) {
      edges.push({ a: cursor, b: sub.start, c: sub.start, quad: false });
    }
  }
  return edges;
}

// --- geometry queries -------------------------------------------------------

function quadPoint(a: Vec2, b: Vec2, c: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return vec2(
    u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    u * u * a.y + 2 * u * t * b.y + t * t * c.y
  );
}

/** Conservative local bounds: the bbox of all on- and off-curve points. */
export function pathBounds(path: Path): Bounds | null {
  const points: Vec2[] = [];
  for (const sub of path.subpaths) {
    points.push(sub.start);
    for (const seg of sub.segments) {
      if (seg.type === 'line') {
        points.push(seg.to);
      } else if (seg.type === 'quad') {
        points.push(seg.control, seg.to);
      } else {
        points.push(seg.c1, seg.c2, seg.to);
      }
    }
  }
  return points.length > 0 ? boundsFromPoints(points) : null;
}

/** Flatten each subpath into a polyline (for hit-testing), tolerance in units. */
export function flattenPath(path: Path, tol = 0.25): Vec2[][] {
  const quads = toQuadraticPath(path, tol);
  const polys: Vec2[][] = [];
  for (const sub of quads.subpaths) {
    const poly: Vec2[] = [sub.start];
    let cursor = sub.start;
    for (const seg of sub.segments) {
      if (seg.type === 'line') {
        poly.push(seg.to);
      } else if (seg.type === 'quad') {
        const steps = Math.max(2, Math.ceil(Math.hypot(seg.to.x - cursor.x, seg.to.y - cursor.y) / 3));
        for (let i = 1; i <= steps; i++) {
          poly.push(quadPoint(cursor, seg.control, seg.to, i / steps));
        }
      }
      cursor = seg.to;
    }
    polys.push(poly);
  }
  return polys;
}

/** Whether `point` is inside `path` under `rule` (flattened winding test). */
export function pointInPath(path: Path, point: Vec2, rule: FillRule = 'nonzero'): boolean {
  let winding = 0;
  for (const poly of flattenPath(path)) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a.y <= point.y) {
        if (b.y > point.y && cross(a, b, point) > 0) {
          winding += 1;
        }
      } else if (b.y <= point.y && cross(a, b, point) < 0) {
        winding -= 1;
      }
    }
  }
  return rule === 'evenodd' ? winding % 2 !== 0 : winding !== 0;
}

function cross(a: Vec2, b: Vec2, p: Vec2): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
