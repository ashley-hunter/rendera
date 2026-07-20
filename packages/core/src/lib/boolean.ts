/**
 * Geometric boolean operations on vector paths — union, intersection,
 * difference, and exclusion (XOR) — producing a NEW exact-curve `Path` (not a
 * rendered region), so the result is editable, strokable, and hit-testable like
 * any other path.
 *
 * Method (the classic split–classify–select–reassemble):
 *   1. Represent both operands as closed contours of cubic Béziers (lines/quads
 *      are exact cubics).
 *   2. Find every intersection between an A-curve and a B-curve (recursive
 *      subdivision), and split both operands at those parameters into pieces —
 *      each piece then lies entirely inside or outside the other operand.
 *   3. Classify each piece by testing its midpoint against the other operand.
 *   4. Select (and orient) the pieces the operation keeps.
 *   5. Reassemble the selected directed pieces into closed contours.
 *
 * Curves stay exact (no flattening of the result). Targets general-position
 * inputs (transversal intersections, no coincident edges); heavily-degenerate
 * overlaps are a known limitation. Pure and DOM-free.
 */

import { pointInPath, type Path, type PathSegment, type SubPath } from './path';
import { add, distance, lerp, scale, subtract, vec2, type Vec2 } from './vec2';

/** A boolean operation over two paths. */
export type BooleanOp = 'union' | 'intersect' | 'difference' | 'xor';

/** A cubic Bézier segment (lines/quadratics are represented exactly as cubics). */
interface Cubic {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}

const EPS = 1e-4; // "already closed?" tolerance (path units)
const FLAT = 1e-3; // curve flatness tolerance for intersection
const MERGE = 2e-2; // endpoint-matching tolerance (intersections computed to ~FLAT)

/** Append `value` to the array at `key`, creating it if needed. */
function pushInto(map: Map<string, number[]>, key: string, value: number): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function evalCubic(c: Cubic, t: number): Vec2 {
  const a = lerp(c.p0, c.p1, t);
  const b = lerp(c.p1, c.p2, t);
  const d = lerp(c.p2, c.p3, t);
  const e = lerp(a, b, t);
  const f = lerp(b, d, t);
  return lerp(e, f, t);
}

/** de Casteljau split at t into [0,t] and [t,1]. */
function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const a = lerp(c.p0, c.p1, t);
  const b = lerp(c.p1, c.p2, t);
  const d = lerp(c.p2, c.p3, t);
  const e = lerp(a, b, t);
  const f = lerp(b, d, t);
  const g = lerp(e, f, t);
  return [
    { p0: c.p0, p1: a, p2: e, p3: g },
    { p0: g, p1: f, p2: d, p3: c.p3 },
  ];
}

/** The sub-curve over [t0, t1]. */
function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  if (t0 <= 0 && t1 >= 1) return c;
  const right = t0 > 0 ? splitCubic(c, t0)[1] : c;
  if (t1 >= 1) return right;
  const nt = t0 < 1 ? (t1 - t0) / (1 - t0) : 0;
  return splitCubic(right, nt)[0];
}

const reverseCubic = (c: Cubic): Cubic => ({ p0: c.p3, p1: c.p2, p2: c.p1, p3: c.p0 });

function cubicBounds(c: Cubic): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(c.p0.x, c.p1.x, c.p2.x, c.p3.x),
    minY: Math.min(c.p0.y, c.p1.y, c.p2.y, c.p3.y),
    maxX: Math.max(c.p0.x, c.p1.x, c.p2.x, c.p3.x),
    maxY: Math.max(c.p0.y, c.p1.y, c.p2.y, c.p3.y),
  };
}

/** How far the control points stray from the chord p0→p3. */
function flatness(c: Cubic): number {
  const distToChord = (p: Vec2): number => {
    const ab = subtract(c.p3, c.p0);
    const len2 = ab.x * ab.x + ab.y * ab.y;
    if (len2 < 1e-12) return distance(p, c.p0);
    const ap = subtract(p, c.p0);
    return Math.abs(ap.x * ab.y - ap.y * ab.x) / Math.sqrt(len2);
  };
  return Math.max(distToChord(c.p1), distToChord(c.p2));
}

/** Intersection of two segments, returning the params (u, v) if they cross. */
function segSeg(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): { u: number; v: number } | null {
  const r = subtract(a1, a0);
  const s = subtract(b1, b0);
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const qp = subtract(b0, a0);
  const u = (qp.x * s.y - qp.y * s.x) / denom;
  const v = (qp.x * r.y - qp.y * r.x) / denom;
  if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) return null;
  return { u: Math.min(Math.max(u, 0), 1), v: Math.min(Math.max(v, 0), 1) };
}

/** Collect intersection parameters (ta on A, tb on B) between two cubics. */
function intersectCubics(
  a: Cubic,
  b: Cubic,
  ta0: number,
  ta1: number,
  tb0: number,
  tb1: number,
  depth: number,
  out: { ta: number; tb: number }[]
): void {
  const ab = cubicBounds(a);
  const bb = cubicBounds(b);
  if (ab.maxX < bb.minX || bb.maxX < ab.minX || ab.maxY < bb.minY || bb.maxY < ab.minY) {
    return;
  }
  if (depth >= 30 || (flatness(a) < FLAT && flatness(b) < FLAT)) {
    const hit = segSeg(a.p0, a.p3, b.p0, b.p3);
    if (hit) {
      out.push({ ta: ta0 + (ta1 - ta0) * hit.u, tb: tb0 + (tb1 - tb0) * hit.v });
    }
    return;
  }
  const [a1, a2] = splitCubic(a, 0.5);
  const [b1, b2] = splitCubic(b, 0.5);
  const tam = (ta0 + ta1) / 2;
  const tbm = (tb0 + tb1) / 2;
  intersectCubics(a1, b1, ta0, tam, tb0, tbm, depth + 1, out);
  intersectCubics(a1, b2, ta0, tam, tbm, tb1, depth + 1, out);
  intersectCubics(a2, b1, tam, ta1, tb0, tbm, depth + 1, out);
  intersectCubics(a2, b2, tam, ta1, tbm, tb1, depth + 1, out);
}

/** Convert a path's subpaths into closed contours of cubics. */
function pathToContours(path: Path): Cubic[][] {
  const contours: Cubic[][] = [];
  for (const sp of path.subpaths) {
    const cubics: Cubic[] = [];
    let cur = sp.start;
    for (const seg of sp.segments) {
      if (seg.type === 'line') {
        cubics.push(lineCubic(cur, seg.to));
        cur = seg.to;
      } else if (seg.type === 'quad') {
        cubics.push(quadCubic(cur, seg.control, seg.to));
        cur = seg.to;
      } else {
        cubics.push({ p0: cur, p1: seg.c1, p2: seg.c2, p3: seg.to });
        cur = seg.to;
      }
    }
    if (cubics.length > 0 && distance(cur, sp.start) > EPS) {
      cubics.push(lineCubic(cur, sp.start)); // close the contour
    }
    if (cubics.length > 0) contours.push(cubics);
  }
  return contours;
}

const lineCubic = (p0: Vec2, p3: Vec2): Cubic => ({ p0, p1: lerp(p0, p3, 1 / 3), p2: lerp(p0, p3, 2 / 3), p3 });
function quadCubic(p0: Vec2, c: Vec2, p3: Vec2): Cubic {
  return { p0, p1: add(p0, scale(subtract(c, p0), 2 / 3)), p2: add(p3, scale(subtract(c, p3), 2 / 3)), p3 };
}

/** Split every cubic of `contours` at the given parameters (grouped by index). */
function splitContours(contours: Cubic[][], params: Map<string, number[]>): Cubic[] {
  const pieces: Cubic[] = [];
  contours.forEach((contour, ci) => {
    contour.forEach((cubic, si) => {
      const ts = (params.get(`${ci}:${si}`) ?? [])
        .filter((t) => t > 1e-6 && t < 1 - 1e-6)
        .sort((x, y) => x - y);
      let prev = 0;
      const cuts = [...ts, 1];
      for (const t of cuts) {
        if (t - prev > 1e-6) {
          pieces.push(subCubic(cubic, prev, t));
        }
        prev = t;
      }
    });
  });
  return pieces;
}

/** A directed piece with its source and inside/outside classification. */
interface Piece {
  cubic: Cubic;
  mid: Vec2;
}

function pieceMid(c: Cubic): Vec2 {
  return evalCubic(c, 0.5);
}

/**
 * The boolean `op` of paths `a` and `b`, as a new path with exact curves.
 * Operands are treated as closed, non-zero-filled regions.
 */
export function booleanPath(a: Path, b: Path, op: BooleanOp): Path {
  const ca = pathToContours(a);
  const cb = pathToContours(b);
  if (ca.length === 0) return op === 'intersect' ? { subpaths: [] } : b;
  if (cb.length === 0) return op === 'intersect' ? { subpaths: [] } : a;

  // 1–2. Intersections + split parameters per cubic.
  const paramsA = new Map<string, number[]>();
  const paramsB = new Map<string, number[]>();
  ca.forEach((ac, ai) =>
    ac.forEach((acu, asi) =>
      cb.forEach((bc, bi) =>
        bc.forEach((bcu, bsi) => {
          const hits: { ta: number; tb: number }[] = [];
          intersectCubics(acu, bcu, 0, 1, 0, 1, 0, hits);
          for (const h of hits) {
            pushInto(paramsA, `${ai}:${asi}`, h.ta);
            pushInto(paramsB, `${bi}:${bsi}`, h.tb);
          }
        })
      )
    )
  );

  const piecesA = splitContours(ca, paramsA).map((cubic) => ({ cubic, mid: pieceMid(cubic) }));
  const piecesB = splitContours(cb, paramsB).map((cubic) => ({ cubic, mid: pieceMid(cubic) }));

  // 3–4. Classify + select (and orient) per operation.
  const selected: Cubic[] = [];
  const aInB = (p: Piece): boolean => pointInPath(b, p.mid, 'nonzero');
  const bInA = (p: Piece): boolean => pointInPath(a, p.mid, 'nonzero');

  const collect = (dst: BooleanOp): void => {
    for (const p of piecesA) {
      const inside = aInB(p);
      if (dst === 'union' && !inside) selected.push(p.cubic);
      else if (dst === 'intersect' && inside) selected.push(p.cubic);
      else if (dst === 'difference' && !inside) selected.push(p.cubic);
    }
    for (const p of piecesB) {
      const inside = bInA(p);
      if (dst === 'union' && !inside) selected.push(p.cubic);
      else if (dst === 'intersect' && inside) selected.push(p.cubic);
      else if (dst === 'difference' && inside) selected.push(reverseCubic(p.cubic));
    }
  };

  if (op === 'xor') {
    // A⊖B = (A−B) ∪ (B−A): A-outside-B fwd + B-inside-A rev + B-outside-A fwd + A-inside-B rev.
    for (const p of piecesA) selected.push(aInB(p) ? reverseCubic(p.cubic) : p.cubic);
    for (const p of piecesB) selected.push(bInA(p) ? reverseCubic(p.cubic) : p.cubic);
  } else {
    collect(op);
  }

  // 5. Reassemble directed pieces into closed contours.
  return { subpaths: reassemble(selected) };
}

/** Connect directed cubics end→start into closed subpaths. */
function reassemble(pieces: Cubic[]): SubPath[] {
  const used = new Array<boolean>(pieces.length).fill(false);

  const findNext = (end: Vec2): number => {
    let best = -1;
    let bestD = MERGE * 2;
    pieces.forEach((c, i) => {
      if (!used[i]) {
        const d = distance(c.p0, end);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    });
    return best;
  };

  const subpaths: SubPath[] = [];
  for (let start = 0; start < pieces.length; start++) {
    if (used[start]) continue;
    const segments: PathSegment[] = [];
    let i = start;
    let guard = 0;
    while (i >= 0 && !used[i] && guard++ < pieces.length + 2) {
      const c = pieces[i];
      used[i] = true;
      segments.push({ type: 'cubic', c1: c.p1, c2: c.p2, to: c.p3 });
      if (distance(c.p3, pieces[start].p0) < MERGE) break; // closed the loop
      i = findNext(c.p3);
    }
    if (segments.length > 0) {
      subpaths.push({ start: pieces[start].p0, segments, closed: true });
    }
  }
  return subpaths;
}
