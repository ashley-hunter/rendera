/**
 * SVG path-data (`d` attribute) parser — owned, dependency-free.
 *
 * Implements the full path grammar (SVG 1.1 §8.3): moveto/lineto/horizontal/
 * vertical, cubic + smooth-cubic, quadratic + smooth-quadratic, elliptical arc,
 * and closepath, in both absolute (upper-case) and relative (lower-case) forms,
 * with implicit command repetition and the compact number syntax SVG allows
 * (`1.5.5` → `1.5 .5`, `1-2` → `1 -2`, arc flags with no separator). Elliptical
 * arcs are converted to cubic Béziers (≤90° segments) so the output is a plain
 * `Path` that flows straight through the analytic fill — no arc primitive needed
 * downstream. Y-down throughout, matching SVG and rendera screen space.
 */

import type { Path, PathSegment, SubPath } from '../path';
import { vec2, type Vec2 } from '../vec2';

/** Tokenizes the compact SVG number/command stream from a `d` string. */
class PathScanner {
  private i = 0;
  constructor(private readonly s: string) {}

  private isWs(c: string): boolean {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === ',';
  }

  skipWs(): void {
    while (this.i < this.s.length && this.isWs(this.s[this.i])) this.i++;
  }

  atEnd(): boolean {
    this.skipWs();
    return this.i >= this.s.length;
  }

  /** Peek the next non-whitespace char without consuming it. */
  peek(): string {
    this.skipWs();
    return this.i < this.s.length ? this.s[this.i] : '';
  }

  /** Consume a command letter if the next token is one. */
  command(): string | null {
    this.skipWs();
    const c = this.s[this.i];
    if (c && /[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      this.i++;
      return c;
    }
    return null;
  }

  /** Parse a floating-point number (SVG compact syntax). */
  number(): number {
    this.skipWs();
    const start = this.i;
    if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
    while (this.i < this.s.length && this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++;
    if (this.s[this.i] === '.') {
      this.i++;
      while (this.i < this.s.length && this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++;
    }
    if (this.s[this.i] === 'e' || this.s[this.i] === 'E') {
      this.i++;
      if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
      while (this.i < this.s.length && this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++;
    }
    const text = this.s.slice(start, this.i);
    const value = Number(text);
    if (text === '' || Number.isNaN(value)) {
      throw new Error(`invalid number in path data at index ${start}`);
    }
    return value;
  }

  /** Arc flag: a single `0` or `1`, no separator required. */
  flag(): boolean {
    this.skipWs();
    const c = this.s[this.i];
    if (c === '0' || c === '1') {
      this.i++;
      return c === '1';
    }
    throw new Error(`expected arc flag (0 or 1) at index ${this.i}`);
  }
}

/** Working state while building subpaths from the command stream. */
interface Builder {
  subpaths: SubPath[];
  segments: PathSegment[];
  start: Vec2; // current subpath's start point
  cursor: Vec2; // current pen position
  open: boolean; // a subpath is being built
  prevCubic: Vec2 | null; // previous cubic's 2nd control (for S/s reflection)
  prevQuad: Vec2 | null; // previous quad's control (for T/t reflection)
}

function flush(b: Builder, closed: boolean): void {
  if (b.open) {
    b.subpaths.push({ start: b.start, segments: b.segments, closed });
  }
  b.segments = [];
  b.open = false;
}

/** A drawing command after a `Z` (with no moveto) reopens a subpath at the pen. */
function ensureOpen(b: Builder): void {
  if (!b.open) {
    b.start = b.cursor;
    b.open = true;
  }
}

/** Parse an SVG `d` attribute into a `Path`. Throws on malformed input. */
export function parsePathData(d: string): Path {
  const sc = new PathScanner(d);
  const b: Builder = {
    subpaths: [],
    segments: [],
    start: vec2(0, 0),
    cursor: vec2(0, 0),
    open: false,
    prevCubic: null,
    prevQuad: null,
  };

  let cmd = sc.command();
  if (cmd && cmd !== 'M' && cmd !== 'm') {
    throw new Error('path data must begin with a moveto (M/m)');
  }

  while (cmd) {
    const rel = cmd === cmd.toLowerCase();
    const abs = (x: number, y: number): Vec2 =>
      rel ? vec2(b.cursor.x + x, b.cursor.y + y) : vec2(x, y);

    switch (cmd.toUpperCase()) {
      case 'M': {
        // First pair is the moveto; subsequent pairs are implicit linetos.
        flush(b, false);
        const p = abs(sc.number(), sc.number());
        b.start = p;
        b.cursor = p;
        b.open = true;
        b.prevCubic = null;
        b.prevQuad = null;
        while (!sc.atEnd() && isCoord(sc)) {
          const l = abs(sc.number(), sc.number());
          b.segments.push({ type: 'line', to: l });
          b.cursor = l;
        }
        break;
      }
      case 'L': {
        ensureOpen(b);
        do {
          const p = abs(sc.number(), sc.number());
          b.segments.push({ type: 'line', to: p });
          b.cursor = p;
        } while (!sc.atEnd() && isCoord(sc));
        b.prevCubic = null;
        b.prevQuad = null;
        break;
      }
      case 'H': {
        ensureOpen(b);
        do {
          const x = rel ? b.cursor.x + sc.number() : sc.number();
          const p = vec2(x, b.cursor.y);
          b.segments.push({ type: 'line', to: p });
          b.cursor = p;
        } while (!sc.atEnd() && isCoord(sc));
        b.prevCubic = null;
        b.prevQuad = null;
        break;
      }
      case 'V': {
        ensureOpen(b);
        do {
          const y = rel ? b.cursor.y + sc.number() : sc.number();
          const p = vec2(b.cursor.x, y);
          b.segments.push({ type: 'line', to: p });
          b.cursor = p;
        } while (!sc.atEnd() && isCoord(sc));
        b.prevCubic = null;
        b.prevQuad = null;
        break;
      }
      case 'C': {
        ensureOpen(b);
        do {
          const c1 = abs(sc.number(), sc.number());
          const c2 = abs(sc.number(), sc.number());
          const to = abs(sc.number(), sc.number());
          b.segments.push({ type: 'cubic', c1, c2, to });
          b.cursor = to;
          b.prevCubic = c2;
          b.prevQuad = null;
        } while (!sc.atEnd() && isCoord(sc));
        break;
      }
      case 'S': {
        ensureOpen(b);
        do {
          const c1 = reflect(b.cursor, b.prevCubic);
          const c2 = abs(sc.number(), sc.number());
          const to = abs(sc.number(), sc.number());
          b.segments.push({ type: 'cubic', c1, c2, to });
          b.cursor = to;
          b.prevCubic = c2;
          b.prevQuad = null;
        } while (!sc.atEnd() && isCoord(sc));
        break;
      }
      case 'Q': {
        ensureOpen(b);
        do {
          const control = abs(sc.number(), sc.number());
          const to = abs(sc.number(), sc.number());
          b.segments.push({ type: 'quad', control, to });
          b.cursor = to;
          b.prevQuad = control;
          b.prevCubic = null;
        } while (!sc.atEnd() && isCoord(sc));
        break;
      }
      case 'T': {
        ensureOpen(b);
        do {
          const control = reflect(b.cursor, b.prevQuad);
          const to = abs(sc.number(), sc.number());
          b.segments.push({ type: 'quad', control, to });
          b.cursor = to;
          b.prevQuad = control;
          b.prevCubic = null;
        } while (!sc.atEnd() && isCoord(sc));
        break;
      }
      case 'A': {
        ensureOpen(b);
        do {
          const rx = sc.number();
          const ry = sc.number();
          const rotation = (sc.number() * Math.PI) / 180;
          const largeArc = sc.flag();
          const sweep = sc.flag();
          const to = abs(sc.number(), sc.number());
          for (const seg of arcToCubics(b.cursor, to, rx, ry, rotation, largeArc, sweep)) {
            b.segments.push(seg);
          }
          b.cursor = to;
          b.prevCubic = null;
          b.prevQuad = null;
        } while (!sc.atEnd() && isCoord(sc));
        break;
      }
      case 'Z': {
        flush(b, true);
        b.cursor = b.start;
        b.prevCubic = null;
        b.prevQuad = null;
        break;
      }
    }

    if (sc.atEnd()) break;
    const next = sc.command();
    if (next) {
      cmd = next;
    } else if (cmd === 'Z' || cmd === 'z') {
      // A coordinate right after Z with no command starts a new subpath (moveto).
      throw new Error('unexpected coordinate after closepath');
    } else {
      // Implicit repeat of the previous command (M/m repeats as L/l — handled by
      // the M case consuming its trailing pairs, so here we just re-enter).
      cmd = cmd === 'M' ? 'L' : cmd === 'm' ? 'l' : cmd;
    }
  }

  flush(b, false);
  return { subpaths: b.subpaths };
}

/** Whether the next token looks like a coordinate (number), not a command. */
function isCoord(sc: PathScanner): boolean {
  const c = sc.peek();
  return c !== '' && !/[MmLlHhVvCcSsQqTtAaZz]/.test(c);
}

/** Reflect the previous control point about the current point (S/T smoothing). */
function reflect(cursor: Vec2, prev: Vec2 | null): Vec2 {
  if (!prev) return cursor; // no previous curve: control coincides with the point
  return vec2(2 * cursor.x - prev.x, 2 * cursor.y - prev.y);
}

/**
 * Convert an SVG elliptical arc (endpoint parameterization) to a sequence of
 * cubic Bézier segments (SVG 1.1 §F.6). Degenerate radii collapse to a line.
 */
function arcToCubics(
  from: Vec2,
  to: Vec2,
  rxIn: number,
  ryIn: number,
  phi: number,
  largeArc: boolean,
  sweep: boolean
): PathSegment[] {
  if (rxIn === 0 || ryIn === 0) return [{ type: 'line', to }];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);

  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  // Midpoint in the rotated frame.
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;

  // Correct out-of-range radii (SVG §F.6.6).
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (-coef * (ry * x1p)) / rx;

  // Centre back in the original frame.
  const cx = cosP * cxp - sinP * cyp + (from.x + to.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (from.y + to.y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  // Split into segments each spanning at most 90°.
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / count;
  const k = (4 / 3) * Math.tan(step / 4); // cubic control-arm length factor

  const segments: PathSegment[] = [];
  let t = theta1;
  for (let i = 0; i < count; i++) {
    const t2 = t + step;
    const cos1 = Math.cos(t);
    const sin1 = Math.sin(t);
    const cos2 = Math.cos(t2);
    const sin2 = Math.sin(t2);

    // Points and tangents on the unit ellipse, mapped back through R(phi)·S(rx,ry).
    const map = (ex: number, ey: number): Vec2 =>
      vec2(cx + cosP * rx * ex - sinP * ry * ey, cy + sinP * rx * ex + cosP * ry * ey);
    const p2 = map(cos2, sin2);
    const c1 = map(cos1 - k * sin1, sin1 + k * cos1);
    const c2 = map(cos2 + k * sin2, sin2 - k * cos2);
    segments.push({ type: 'cubic', c1, c2, to: p2 });
    t = t2;
  }
  return segments;
}
