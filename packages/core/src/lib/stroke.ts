/**
 * Stroking — convert a path's centerline into a fill outline (ADR 0007).
 *
 * The centerline is flattened to polylines, then each segment becomes an
 * offset rectangle, each interior vertex a join (miter / round / bevel), and
 * each open end a cap (butt / round / square). All these convex pieces are
 * emitted as sub-paths oriented the same way, so filling the result with the
 * **nonzero** rule yields their union — the stroke. The backend then rasterizes
 * that outline with the ordinary analytic fill, so strokes inherit the
 * resolution-independent AA, band-binning, and compositor for free.
 */

import { flattenSubpaths, type Path, type SubPath } from './path';
import { add, negate, normalize, scale, subtract, vec2, type Vec2 } from './vec2';

export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

export interface StrokeStyle {
  readonly width: number;
  readonly cap?: StrokeCap;
  readonly join?: StrokeJoin;
  readonly miterLimit?: number;
}

const perp = (v: Vec2): Vec2 => vec2(-v.y, v.x);

/** Signed area × 2 (screen space, y-down); >0 and <0 are opposite windings. */
function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/** Force a consistent winding so nonzero-fill unions the pieces. */
function oriented(poly: Vec2[]): Vec2[] {
  return signedArea(poly) > 0 ? poly.slice().reverse() : poly;
}

/** Intersection of the lines p0+t·d0 and p1+u·d1, or null if parallel. */
function lineIntersect(p0: Vec2, d0: Vec2, p1: Vec2, d1: Vec2): Vec2 | null {
  const den = d0.x * d1.y - d0.y * d1.x;
  if (Math.abs(den) < 1e-9) {
    return null;
  }
  const t = ((p1.x - p0.x) * d1.y - (p1.y - p0.y) * d1.x) / den;
  return add(p0, scale(d0, t));
}

function disc(center: Vec2, r: number, steps: number): Vec2[] {
  const poly: Vec2[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    poly.push(vec2(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r));
  }
  return poly;
}

/** Convert an outline polygon into a closed line sub-path. */
function toSubPath(poly: Vec2[]): SubPath {
  return { start: poly[0], closed: true, segments: poly.slice(1).map((to) => ({ type: 'line', to }) as const) };
}

/** Drop consecutive (near-)duplicate points that would give zero-length segments. */
function dedupe(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Build the fill outline of `path` stroked with `style`. Fill the result with
 * the nonzero rule. Widths and coordinates are in the path's own space.
 */
export function strokePath(path: Path, style: StrokeStyle, tol = 0.25): Path {
  const half = style.width / 2;
  if (half <= 0) {
    return { subpaths: [] };
  }
  const cap: StrokeCap = style.cap ?? 'butt';
  const join: StrokeJoin = style.join ?? 'miter';
  const miterLimit = style.miterLimit ?? 4;
  const steps = Math.max(8, Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - tol / half))));

  const pieces: Vec2[][] = [];
  const emit = (poly: Vec2[]): void => {
    if (poly.length >= 3) {
      pieces.push(oriented(poly));
    }
  };

  const emitJoin = (v: Vec2, d0: Vec2, d1: Vec2): void => {
    if (join === 'round') {
      emit(disc(v, half, steps));
      return;
    }
    const n0 = scale(perp(d0), half);
    const n1 = scale(perp(d1), half);
    if (join === 'bevel') {
      emit([v, add(v, n0), add(v, n1)]);
      emit([v, subtract(v, n0), subtract(v, n1)]);
      return;
    }
    // Miter each side; the outer side is the real join, the inner is a small
    // harmless overlap. Fall back to bevel past the miter limit.
    for (const s of [1, -1]) {
      const o0 = add(v, scale(n0, s));
      const o1 = add(v, scale(n1, s));
      const m = lineIntersect(o0, d0, o1, d1);
      if (m && Math.hypot(m.x - v.x, m.y - v.y) / half <= miterLimit) {
        emit([v, o0, m, o1]);
      } else {
        emit([v, o0, o1]);
      }
    }
  };

  const emitCap = (end: Vec2, outDir: Vec2): void => {
    if (cap === 'butt') {
      return;
    }
    if (cap === 'round') {
      emit(disc(end, half, steps));
      return;
    }
    const n = scale(perp(outDir), half);
    const e = add(end, scale(outDir, half));
    emit([add(end, n), add(e, n), subtract(e, n), subtract(end, n)]);
  };

  for (const raw of flattenSubpaths(path, tol)) {
    const pts = dedupe(raw.points);
    const closed = raw.closed;
    if (pts.length < 2) {
      if (pts.length === 1 && cap === 'round') {
        emit(disc(pts[0], half, steps));
      }
      continue;
    }
    const segCount = closed ? pts.length : pts.length - 1;
    const dirs: Vec2[] = [];
    for (let i = 0; i < segCount; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const d = normalize(subtract(b, a));
      dirs.push(d);
      const n = scale(perp(d), half);
      emit([add(a, n), add(b, n), subtract(b, n), subtract(a, n)]);
    }
    // Joins at interior vertices (every vertex when closed).
    const joinCount = closed ? pts.length : pts.length - 2;
    for (let k = 0; k < joinCount; k++) {
      const vi = closed ? k : k + 1;
      const s0 = closed ? (k - 1 + segCount) % segCount : k;
      const s1 = closed ? k : k + 1;
      emitJoin(pts[vi], dirs[s0], dirs[s1]);
    }
    if (!closed) {
      emitCap(pts[0], negate(dirs[0]));
      emitCap(pts[pts.length - 1], dirs[dirs.length - 1]);
    }
  }

  return { subpaths: pieces.map(toSubPath) };
}
