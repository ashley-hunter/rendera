/**
 * Multi-channel signed distance field (MSDF) generation — a pure-TS port of the
 * core of Viktor Chlumsky's `msdfgen` algorithm.
 *
 * An MSDF stores, per pixel, three signed distances (one per colour channel) to
 * differently-coloured edges of the glyph outline. Reconstructing the *median*
 * of the three at sample time recovers the true signed distance while
 * preserving SHARP CORNERS (a single-channel SDF rounds them off). We already
 * own exact distance-to-line/quadratic math; this adds edge colouring, the
 * signed *pseudo*-distance (so channels extend cleanly past edge ends), and the
 * per-channel nearest-edge selection.
 *
 * Framework-agnostic and DOM-free: generation is pure arithmetic over glyph
 * geometry (font units, Y-up), unit-tested by reconstructing coverage. Cubics
 * are converted to quadratics upstream, so only line + quadratic edges appear.
 */

import { toQuadraticPath, type Path } from '../path';
import type { Vec2 } from '../vec2';

/** Channel bit-mask colours (RED=1, GREEN=2, BLUE=4). */
const RED = 1;
const GREEN = 2;
const BLUE = 4;
const YELLOW = RED | GREEN;
const MAGENTA = RED | BLUE;
const CYAN = GREEN | BLUE;
const WHITE = RED | GREEN | BLUE;
const BLACK = 0;

type V = { x: number; y: number };

const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y;
const cross = (a: V, b: V): number => a.x * b.y - a.y * b.x;
const len = (a: V): number => Math.hypot(a.x, a.y);
const norm = (a: V): V => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const nonZeroSign = (x: number): number => (x > 0 ? 1 : -1);

/** A signed distance with a tie-break dot (|cosine| of the incidence angle). */
interface SD {
  distance: number;
  dot: number;
}
/** Order by |distance|, then by dot — the msdfgen `SignedDistance` comparison. */
function closer(a: SD, b: SD): boolean {
  const ad = Math.abs(a.distance);
  const bd = Math.abs(b.distance);
  return ad < bd || (ad === bd && a.dot < b.dot);
}

/** A glyph outline edge (line or quadratic), with an assigned channel colour. */
interface Edge {
  quad: boolean;
  p0: V;
  p1: V; // control (quad) or end (line)
  p2: V; // end (quad only)
  color: number;
}

/** Tangent direction at parameter t (unnormalized). */
function direction(e: Edge, t: number): V {
  if (!e.quad) {
    return sub(e.p1, e.p0);
  }
  // 2[(1-t)(p1-p0) + t(p2-p1)]
  const a = sub(e.p1, e.p0);
  const b = sub(e.p2, e.p1);
  return { x: 2 * ((1 - t) * a.x + t * b.x), y: 2 * ((1 - t) * a.y + t * b.y) };
}
const edgeEnd = (e: Edge): V => (e.quad ? e.p2 : e.p1);

/** Solve a*t^3 + b*t^2 + c*t + d = 0, returning real roots. */
function solveCubic(a: number, b: number, c: number, d: number): number[] {
  if (Math.abs(a) < 1e-12) {
    return solveQuadratic(b, c, d);
  }
  const bn = b / a;
  const cn = c / a;
  const dn = d / a;
  const p = cn - (bn * bn) / 3;
  const q = (2 * bn * bn * bn) / 27 - (bn * cn) / 3 + dn;
  const disc = (q * q) / 4 + (p * p * p) / 27;
  const shift = -bn / 3;
  const roots: number[] = [];
  if (disc > 1e-14) {
    const s = Math.sqrt(disc);
    roots.push(Math.cbrt(-q / 2 + s) + Math.cbrt(-q / 2 - s) + shift);
  } else if (disc > -1e-14) {
    const u = Math.cbrt(-q / 2);
    roots.push(2 * u + shift, -u + shift);
  } else {
    const r = Math.sqrt(-(p * p * p) / 27);
    const phi = Math.acos(-q / (2 * r));
    const m = 2 * Math.cbrt(r);
    roots.push(
      m * Math.cos(phi / 3) + shift,
      m * Math.cos((phi + 2 * Math.PI) / 3) + shift,
      m * Math.cos((phi + 4 * Math.PI) / 3) + shift
    );
  }
  return roots;
}
function solveQuadratic(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) {
    return Math.abs(b) < 1e-12 ? [] : [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    return [];
  }
  const s = Math.sqrt(disc);
  return [(-b + s) / (2 * a), (-b - s) / (2 * a)];
}

/** Signed distance from `o` to edge `e`, plus the nearest parameter `t`. */
function signedDistance(e: Edge, o: V): { sd: SD; t: number } {
  if (!e.quad) {
    const aq = sub(o, e.p0);
    const ab = sub(e.p1, e.p0);
    const param = dot(aq, ab) / dot(ab, ab);
    const eq = sub(param > 0.5 ? e.p1 : e.p0, o);
    const endpointDistance = len(eq);
    if (param > 0 && param < 1) {
      // signed orthogonal distance to the (infinite) line
      const ortho = dot({ x: ab.y, y: -ab.x }, aq) / (len(ab) || 1);
      if (Math.abs(ortho) < endpointDistance) {
        return { sd: { distance: ortho, dot: 0 }, t: param };
      }
    }
    return {
      sd: {
        distance: nonZeroSign(cross(aq, ab)) * endpointDistance,
        dot: Math.abs(dot(norm(ab), norm(eq))),
      },
      t: param,
    };
  }

  const qa = sub(e.p0, o);
  const ab = sub(e.p1, e.p0);
  const br = { x: e.p0.x - 2 * e.p1.x + e.p2.x, y: e.p0.y - 2 * e.p1.y + e.p2.y };
  // Nearest point on the quadratic solves this cubic in t.
  const roots = solveCubic(dot(br, br), 3 * dot(ab, br), 2 * dot(ab, ab) + dot(qa, br), dot(qa, ab));

  let epDir = direction(e, 0);
  let minDistance = nonZeroSign(cross(epDir, qa)) * len(qa);
  let param = -dot(qa, epDir) / dot(epDir, epDir);
  {
    epDir = direction(e, 1);
    const be = sub(e.p2, o);
    const distance = len(be);
    if (distance < Math.abs(minDistance)) {
      minDistance = nonZeroSign(cross(epDir, be)) * distance;
      param = dot(sub(o, e.p1), epDir) / dot(epDir, epDir);
    }
  }
  for (const t of roots) {
    if (t > 0 && t < 1) {
      // point(t) - o = qa + 2t*ab + t^2*br
      const qe = {
        x: qa.x + 2 * t * ab.x + t * t * br.x,
        y: qa.y + 2 * t * ab.y + t * t * br.y,
      };
      const distance = len(qe);
      if (distance <= Math.abs(minDistance)) {
        minDistance = nonZeroSign(cross(direction(e, t), qe)) * distance;
        param = t;
      }
    }
  }
  if (param >= 0 && param <= 1) {
    return { sd: { distance: minDistance, dot: 0 }, t: param };
  }
  if (param < 0.5) {
    return { sd: { distance: minDistance, dot: Math.abs(dot(norm(direction(e, 0)), norm(qa))) }, t: param };
  }
  return {
    sd: { distance: minDistance, dot: Math.abs(dot(norm(direction(e, 1)), norm(sub(e.p2, o)))) },
    t: param,
  };
}

/** Extend a distance to a pseudo-distance past the edge ends (in place). */
function toPseudoDistance(sd: SD, e: Edge, o: V, param: number): void {
  if (param < 0) {
    const dir = norm(direction(e, 0));
    const aq = sub(o, e.p0);
    if (dot(aq, dir) < 0) {
      const pseudo = cross(aq, dir);
      if (Math.abs(pseudo) <= Math.abs(sd.distance)) {
        sd.distance = pseudo;
        sd.dot = 0;
      }
    }
  } else if (param > 1) {
    const dir = norm(direction(e, 1));
    const bq = sub(o, edgeEnd(e));
    if (dot(bq, dir) > 0) {
      const pseudo = cross(bq, dir);
      if (Math.abs(pseudo) <= Math.abs(sd.distance)) {
        sd.distance = pseudo;
        sd.dot = 0;
      }
    }
  }
}

/** Whether two tangent directions meet at a corner (angle threshold via sin). */
function isCorner(a: V, b: V, crossThreshold: number): boolean {
  return dot(a, b) <= 0 || Math.abs(cross(a, b)) > crossThreshold;
}

/** msdfgen `switchColor`: rotate to a colour sharing exactly one channel. */
function switchColor(color: number, seedRef: { s: number }): number {
  if (color === BLACK || color === WHITE) {
    const start = [CYAN, MAGENTA, YELLOW];
    const c = start[seedRef.s % 3];
    seedRef.s = Math.floor(seedRef.s / 3);
    return c;
  }
  const shifted = color << (1 + (seedRef.s & 1));
  seedRef.s >>= 1;
  return (shifted | (shifted >> 3)) & WHITE;
}

/** Assign edge colours so corners are preserved (msdfgen `edgeColoringSimple`). */
function colorEdges(contours: Edge[][], angleThreshold: number): void {
  const crossThreshold = Math.sin(angleThreshold);
  const seed = { s: 0 };
  for (const edges of contours) {
    const m = edges.length;
    if (m === 0) {
      continue;
    }
    // Corner indices: where the previous edge's end tangent meets this edge's
    // start tangent at an angle.
    const corners: number[] = [];
    for (let i = 0; i < m; i++) {
      const prev = edges[(i + m - 1) % m];
      if (isCorner(norm(direction(prev, 1)), norm(direction(edges[i], 0)), crossThreshold)) {
        corners.push(i);
      }
    }
    if (corners.length === 0) {
      for (const e of edges) {
        e.color = WHITE;
      }
    } else if (corners.length === 1) {
      // Teardrop: colour the single spline with a 3-way rotation.
      const colors = [switchColor(WHITE, seed), WHITE, 0];
      colors[2] = switchColor(colors[0], seed);
      const start = corners[0];
      if (m >= 3) {
        for (let i = 0; i < m; i++) {
          const idx = (start + i) % m;
          const b = Math.floor((3 * i - 1) / m);
          const bClamped = Math.min(Math.max(b, 0), 2);
          edges[idx].color = colors[bClamped];
        }
      } else {
        for (let i = 0; i < m; i++) {
          edges[(start + i) % m].color = colors[Math.min(i, 2)];
        }
      }
    } else {
      let color = switchColor(WHITE, seed);
      const start = corners[0];
      let spline = 0;
      const cornerCount = corners.length;
      for (let i = 0; i < m; i++) {
        const idx = (start + i) % m;
        if (spline < cornerCount && corners[spline] === idx) {
          color = switchColor(color, seed);
          spline++;
        }
        edges[idx].color = color;
      }
    }
  }
}

/** Build coloured contours (line + quad edges) from a glyph `Path` (Y-up). */
function pathToContours(path: Path): Edge[][] {
  // Convert cubics to quadratics at a tight tolerance so only line/quad remain.
  const quadPath = toQuadraticPath(path, 2);
  const contours: Edge[][] = [];
  for (const subpath of quadPath.subpaths) {
    const edges: Edge[] = [];
    let cur: Vec2 = subpath.start;
    for (const seg of subpath.segments) {
      if (seg.type === 'line') {
        edges.push({ quad: false, p0: cur, p1: seg.to, p2: seg.to, color: WHITE });
        cur = seg.to;
      } else if (seg.type === 'quad') {
        edges.push({ quad: true, p0: cur, p1: seg.control, p2: seg.to, color: WHITE });
        cur = seg.to;
      }
    }
    // Close the contour if the outline didn't return to the start.
    if (edges.length > 0 && (cur.x !== subpath.start.x || cur.y !== subpath.start.y)) {
      edges.push({ quad: false, p0: cur, p1: subpath.start, p2: subpath.start, color: WHITE });
    }
    if (edges.length > 0) {
      contours.push(edges);
    }
  }
  return contours;
}

/** A generated glyph MSDF and the metrics needed to place + sample it. */
export interface GlyphMsdf {
  /** RGBA8 field, row-major, top row first (Y-down texture). */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Distance range in atlas px (spread); the sampler needs this. */
  readonly pxRange: number;
  /** Glyph quad bounds in em units relative to the origin/baseline (Y-up):
   * the padded cell, so the AA band is included. */
  readonly plane: { left: number; right: number; top: number; bottom: number };
  /** Whether the glyph had any geometry (space glyphs are empty). */
  readonly empty: boolean;
}

export interface MsdfOptions {
  /** Em size of the glyph in the atlas, px (32–48 typical). Default 40. */
  readonly emPx?: number;
  /** Distance range (spread) in atlas px. Default 4. */
  readonly pxRange?: number;
  /** Corner angle threshold in radians. Default 3 (~172°). */
  readonly angleThreshold?: number;
  /** upem of the font (units per em). */
  readonly upem: number;
}

/**
 * Generate an MSDF for one glyph outline (`path`, font units, Y-up). Returns the
 * RGBA8 field plus placement metrics. Reconstruct coverage by sampling the
 * atlas and taking `median(r,g,b)`.
 */
export function generateGlyphMsdf(path: Path, options: MsdfOptions): GlyphMsdf {
  const emPx = options.emPx ?? 40;
  const pxRange = options.pxRange ?? 4;
  const angleThreshold = options.angleThreshold ?? 3;
  const scale = emPx / options.upem; // atlas px per font unit
  const pad = Math.ceil(pxRange / 2) + 1; // atlas px of padding per side

  const contours = pathToContours(path);
  if (contours.length === 0) {
    return {
      data: new Uint8ClampedArray(0),
      width: 0,
      height: 0,
      pxRange,
      plane: { left: 0, right: 0, top: 0, bottom: 0 },
      empty: true,
    };
  }
  colorEdges(contours, angleThreshold);

  // Font-unit bounding box of the outline.
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const edges of contours) {
    for (const e of edges) {
      for (const p of e.quad ? [e.p0, e.p1, e.p2] : [e.p0, e.p1]) {
        xMin = Math.min(xMin, p.x);
        yMin = Math.min(yMin, p.y);
        xMax = Math.max(xMax, p.x);
        yMax = Math.max(yMax, p.y);
      }
    }
  }
  const width = Math.ceil((xMax - xMin) * scale) + 2 * pad;
  const height = Math.ceil((yMax - yMin) * scale) + 2 * pad;
  const range = pxRange / scale; // distance range in font units
  const data = new Uint8ClampedArray(width * height * 4);

  for (let j = 0; j < height; j++) {
    // Row 0 = top of the texture = high font Y (Y-up geometry, Y-down texture).
    const fy = yMax - (j + 0.5 - pad) / scale;
    for (let i = 0; i < width; i++) {
      const fx = xMin + (i + 0.5 - pad) / scale;
      const o: V = { x: fx, y: fy };

      let rSD: SD = { distance: -Infinity, dot: 0 };
      let gSD: SD = { distance: -Infinity, dot: 0 };
      let bSD: SD = { distance: -Infinity, dot: 0 };
      let rEdge: Edge | null = null;
      let gEdge: Edge | null = null;
      let bEdge: Edge | null = null;
      let rT = 0;
      let gT = 0;
      let bT = 0;

      for (const edges of contours) {
        for (const e of edges) {
          const { sd, t } = signedDistance(e, o);
          if (e.color & RED && closer(sd, rSD)) {
            rSD = { ...sd };
            rEdge = e;
            rT = t;
          }
          if (e.color & GREEN && closer(sd, gSD)) {
            gSD = { ...sd };
            gEdge = e;
            gT = t;
          }
          if (e.color & BLUE && closer(sd, bSD)) {
            bSD = { ...sd };
            bEdge = e;
            bT = t;
          }
        }
      }
      if (rEdge) toPseudoDistance(rSD, rEdge, o, rT);
      if (gEdge) toPseudoDistance(gSD, gEdge, o, gT);
      if (bEdge) toPseudoDistance(bSD, bEdge, o, bT);

      const k = (j * width + i) * 4;
      data[k] = (rSD.distance / range + 0.5) * 255;
      data[k + 1] = (gSD.distance / range + 0.5) * 255;
      data[k + 2] = (bSD.distance / range + 0.5) * 255;
      data[k + 3] = 255;
    }
  }

  return {
    data,
    width,
    height,
    pxRange,
    plane: {
      left: (xMin - pad / scale) / options.upem,
      right: (xMax + pad / scale) / options.upem,
      top: (yMax + pad / scale) / options.upem,
      bottom: (yMin - pad / scale) / options.upem,
    },
    empty: false,
  };
}

/** The median of three values — the MSDF reconstruction of true distance. */
export function median(r: number, g: number, b: number): number {
  return Math.max(Math.min(r, g), Math.min(Math.max(r, g), b));
}
