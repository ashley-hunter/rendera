/**
 * Stroking — convert a path's centerline into a fill outline (ADR 0007).
 *
 * Each segment becomes an offset piece (a curve offset by ±half on each side,
 * capped at its ends), each corner a join (miter / round / bevel), and each open
 * end a cap. Crucially the offset of a curve is approximated by *quadratics*, not
 * flattened to line segments — so a stroked curve carries a handful of exact
 * edges (like its fill) and stays razor-sharp at any zoom, instead of thousands
 * of tiny facets. All pieces are emitted with a consistent winding, so filling
 * the result with the **nonzero** rule yields their union — the stroke — which
 * the backend rasterizes with the ordinary analytic fill (AA, binning,
 * compositing for free).
 */

import { toQuadraticPath, type Path, type SubPath } from './path';
import { add, dot, negate, normalize, scale, subtract, vec2, type Vec2 } from './vec2';

export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export interface StrokeStyle {
  readonly width: number;
  readonly cap?: StrokeCap;
  readonly join?: StrokeJoin;
  readonly miterLimit?: number;
}

const perp = (v: Vec2): Vec2 => vec2(-v.y, v.x);

/** Signed area × 2 of a polygon; sign is the winding. */
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

// --- Quadratic helpers (Y-agnostic) ------------------------------------------

const qEval = (p0: Vec2, c: Vec2, p1: Vec2, t: number): Vec2 => {
  const u = 1 - t;
  return vec2(u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, u * u * p0.y + 2 * u * t * c.y + t * t * p1.y);
};
/** Tangent (unnormalized derivative) of a quadratic at t. */
const qTangent = (p0: Vec2, c: Vec2, p1: Vec2, t: number): Vec2 =>
  vec2(2 * ((1 - t) * (c.x - p0.x) + t * (p1.x - c.x)), 2 * ((1 - t) * (c.y - p0.y) + t * (p1.y - c.y)));

/** The sub-quadratic over [t0, t1] (de Casteljau). */
function subQuad(p0: Vec2, c: Vec2, p1: Vec2, t0: number, t1: number): [Vec2, Vec2, Vec2] {
  const a0 = qEval(p0, c, p1, t0);
  const a1 = qEval(p0, c, p1, t1);
  // Control = intersection of the endpoint tangents (exact for a quadratic).
  const m = lineIntersect(a0, qTangent(p0, c, p1, t0), a1, qTangent(p0, c, p1, t1));
  return [a0, m ?? vec2((a0.x + a1.x) / 2, (a0.y + a1.y) / 2), a1];
}

/**
 * Build the fill outline of `path` stroked with `style`. Fill the result with
 * the nonzero rule. Widths and coordinates are in the path's own space; `tol`
 * bounds the offset-curve and join approximation error (path units).
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
  // One arc-segment's angle keeps its chord within `tol` of the true circle; a
  // turn shallower than this needs no join (the offset pieces already meet).
  const segAngle = 2 * Math.acos(Math.max(0, 1 - tol / half));

  const subpaths: SubPath[] = [];
  const emitPoly = (poly: Vec2[]): void => {
    if (poly.length >= 3) {
      subpaths.push(toSubPath(oriented(poly)));
    }
  };

  // Offset one quadratic on both sides into a curved piece (two offset quads
  // joined by straight end-caps), subdividing until the offset is within `tol`.
  const emitQuadOffset = (p0: Vec2, c: Vec2, p1: Vec2, depth: number): void => {
    const t0 = normalize(qTangent(p0, c, p1, 0));
    const t1 = normalize(qTangent(p0, c, p1, 1));
    const n0 = perp(t0);
    const n1 = perp(t1);
    const pPlus0 = add(p0, scale(n0, half));
    const pPlus1 = add(p1, scale(n1, half));
    const pMinus0 = subtract(p0, scale(n0, half));
    const pMinus1 = subtract(p1, scale(n1, half));
    const cPlus = lineIntersect(pPlus0, t0, pPlus1, t1) ?? vec2((pPlus0.x + pPlus1.x) / 2, (pPlus0.y + pPlus1.y) / 2);
    const cMinus =
      lineIntersect(pMinus0, t0, pMinus1, t1) ?? vec2((pMinus0.x + pMinus1.x) / 2, (pMinus0.y + pMinus1.y) / 2);

    if (depth < 10) {
      // Error at the midpoint: true offset vs the offset-quad approximation.
      const mid = qEval(p0, c, p1, 0.5);
      const nMid = perp(normalize(qTangent(p0, c, p1, 0.5)));
      const truePlus = add(mid, scale(nMid, half));
      const trueMinus = subtract(mid, scale(nMid, half));
      const approxPlus = qEval(pPlus0, cPlus, pPlus1, 0.5);
      const approxMinus = qEval(pMinus0, cMinus, pMinus1, 0.5);
      const err = Math.max(
        Math.hypot(truePlus.x - approxPlus.x, truePlus.y - approxPlus.y),
        Math.hypot(trueMinus.x - approxMinus.x, trueMinus.y - approxMinus.y)
      );
      if (err > tol) {
        const [la0, lc, lm] = subQuad(p0, c, p1, 0, 0.5);
        const [, rc, rp1] = subQuad(p0, c, p1, 0.5, 1);
        emitQuadOffset(la0, lc, lm, depth + 1);
        emitQuadOffset(lm, rc, rp1, depth + 1);
        return;
      }
    }
    // Emit the curved piece with a consistent winding (match oriented()'s ≤0).
    const area = signedArea([pPlus0, pPlus1, pMinus1, pMinus0]);
    const fwd: SubPath = {
      start: pPlus0,
      closed: true,
      segments: [
        { type: 'quad', control: cPlus, to: pPlus1 },
        { type: 'line', to: pMinus1 },
        { type: 'quad', control: cMinus, to: pMinus0 },
        { type: 'line', to: pPlus0 },
      ],
    };
    const rev: SubPath = {
      start: pPlus0,
      closed: true,
      segments: [
        { type: 'line', to: pMinus0 },
        { type: 'quad', control: cMinus, to: pMinus1 },
        { type: 'line', to: pPlus1 },
        { type: 'quad', control: cPlus, to: pPlus0 },
      ],
    };
    subpaths.push(area > 0 ? rev : fwd);
  };

  const emitJoin = (v: Vec2, d0: Vec2, d1: Vec2): void => {
    if (join === 'round') {
      const turn = Math.atan2(cross(d0, d1), dot(d0, d1));
      if (Math.abs(turn) < segAngle) {
        return; // shallower than one arc-segment — pieces already meet
      }
      const s = turn > 0 ? -1 : 1; // outer offset sign (perp points left of dir)
      const a0 = Math.atan2(s * d0.x, -s * d0.y); // angle of s·perp(d0)
      const a1 = Math.atan2(s * d1.x, -s * d1.y);
      let delta = a1 - a0;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      const nSeg = Math.max(1, Math.ceil(Math.abs(delta) / segAngle));
      const fan: Vec2[] = [v];
      for (let i = 0; i <= nSeg; i++) {
        const a = a0 + (delta * i) / nSeg;
        fan.push(vec2(v.x + Math.cos(a) * half, v.y + Math.sin(a) * half));
      }
      emitPoly(fan);
      return;
    }
    const n0 = scale(perp(d0), half);
    const n1 = scale(perp(d1), half);
    if (join === 'bevel') {
      emitPoly([v, add(v, n0), add(v, n1)]);
      emitPoly([v, subtract(v, n0), subtract(v, n1)]);
      return;
    }
    // Miter each side; the outer side is the real join, the inner a small
    // harmless overlap. Fall back to bevel past the miter limit.
    for (const s of [1, -1]) {
      const o0 = add(v, scale(n0, s));
      const o1 = add(v, scale(n1, s));
      const m = lineIntersect(o0, d0, o1, d1);
      if (m && Math.hypot(m.x - v.x, m.y - v.y) / half <= miterLimit) {
        emitPoly([v, o0, m, o1]);
      } else {
        emitPoly([v, o0, o1]);
      }
    }
  };

  const emitCap = (end: Vec2, outDir: Vec2): void => {
    if (cap === 'butt') {
      return;
    }
    if (cap === 'round') {
      emitPoly(disc(end, half, steps));
      return;
    }
    const n = scale(perp(outDir), half);
    const e = add(end, scale(outDir, half));
    emitPoly([add(end, n), add(e, n), subtract(e, n), subtract(end, n)]);
  };

  // Work in quadratics (cubics → quads at `tol`); lines stay exact.
  for (const sp of toQuadraticPath(path, tol).subpaths) {
    // Gather segments as {p0, p1, control?} plus start/end tangents.
    type Seg = { p0: Vec2; p1: Vec2; startDir: Vec2; endDir: Vec2; control?: Vec2 };
    const segs: Seg[] = [];
    let cur = sp.start;
    for (const s of sp.segments) {
      if (s.type === 'line') {
        const d = subtract(s.to, cur);
        if (Math.hypot(d.x, d.y) > 1e-9) {
          const n = normalize(d);
          segs.push({ p0: cur, p1: s.to, startDir: n, endDir: n });
        }
        cur = s.to;
      } else if (s.type === 'quad') {
        const startDir = normalize(qTangent(cur, s.control, s.to, 0));
        const endDir = normalize(qTangent(cur, s.control, s.to, 1));
        segs.push({ p0: cur, p1: s.to, startDir, endDir, control: s.control });
        cur = s.to;
      }
    }
    // Add the implicit closing edge (a closed subpath need not restate it).
    if (sp.closed && segs.length > 0 && Math.hypot(cur.x - sp.start.x, cur.y - sp.start.y) > 1e-9) {
      const n = normalize(subtract(sp.start, cur));
      segs.push({ p0: cur, p1: sp.start, startDir: n, endDir: n });
      cur = sp.start;
    }
    if (segs.length === 0) {
      // A lone move (isolated point) still gets a round dot.
      if (cap === 'round') emitPoly(disc(sp.start, half, steps));
      continue;
    }
    const closed = sp.closed || Math.hypot(cur.x - sp.start.x, cur.y - sp.start.y) <= 1e-6;

    for (const seg of segs) {
      if (seg.control) {
        emitQuadOffset(seg.p0, seg.control, seg.p1, 0);
      } else {
        const n = scale(perp(seg.startDir), half);
        emitPoly([add(seg.p0, n), add(seg.p1, n), subtract(seg.p1, n), subtract(seg.p0, n)]);
      }
    }
    // Joins at the vertices between consecutive segments (and the wrap if closed).
    for (let i = 0; i < segs.length - 1; i++) {
      emitJoin(segs[i].p1, segs[i].endDir, segs[i + 1].startDir);
    }
    if (closed) {
      emitJoin(segs[segs.length - 1].p1, segs[segs.length - 1].endDir, segs[0].startDir);
    } else {
      emitCap(segs[0].p0, negate(segs[0].startDir));
      emitCap(segs[segs.length - 1].p1, segs[segs.length - 1].endDir);
    }
  }

  return { subpaths };
}
