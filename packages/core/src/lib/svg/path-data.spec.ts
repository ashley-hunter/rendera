import { parsePathData } from './path-data';
import type { PathSegment } from '../path';

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

describe('parsePathData', () => {
  it('parses an absolute moveto + lineto into one open subpath', () => {
    const p = parsePathData('M 10 20 L 30 40');
    expect(p.subpaths).toHaveLength(1);
    expect(p.subpaths[0].start).toEqual({ x: 10, y: 20 });
    expect(p.subpaths[0].closed).toBe(false);
    expect(p.subpaths[0].segments).toEqual([{ type: 'line', to: { x: 30, y: 40 } }]);
  });

  it('treats extra pairs after a moveto as implicit linetos', () => {
    const p = parsePathData('M0 0 1 1 2 2');
    expect(p.subpaths[0].segments).toEqual([
      { type: 'line', to: { x: 1, y: 1 } },
      { type: 'line', to: { x: 2, y: 2 } },
    ]);
  });

  it('resolves relative commands against the running pen', () => {
    const p = parsePathData('M10 10 l5 0 l0 5');
    expect(p.subpaths[0].segments).toEqual([
      { type: 'line', to: { x: 15, y: 10 } },
      { type: 'line', to: { x: 15, y: 15 } },
    ]);
  });

  it('handles H and V (absolute and relative)', () => {
    const p = parsePathData('M0 0 H10 V10 h-5 v-5');
    expect(p.subpaths[0].segments).toEqual([
      { type: 'line', to: { x: 10, y: 0 } },
      { type: 'line', to: { x: 10, y: 10 } },
      { type: 'line', to: { x: 5, y: 10 } },
      { type: 'line', to: { x: 5, y: 5 } },
    ]);
  });

  it('closes a subpath on Z and starts a new one on the next M', () => {
    const p = parsePathData('M0 0 L10 0 Z M20 20 L30 20 Z');
    expect(p.subpaths).toHaveLength(2);
    expect(p.subpaths[0].closed).toBe(true);
    expect(p.subpaths[1].closed).toBe(true);
    expect(p.subpaths[1].start).toEqual({ x: 20, y: 20 });
  });

  it('reflects the previous control point for smooth cubics (S)', () => {
    // First cubic ends at (10,0) with 2nd control (8,-4); S reflects it to (12,4).
    const p = parsePathData('M0 0 C 2 4 8 -4 10 0 S 18 4 20 0');
    const seg = p.subpaths[0].segments[1] as Extract<PathSegment, { type: 'cubic' }>;
    expect(seg.type).toBe('cubic');
    expect(seg.c1).toEqual({ x: 12, y: 4 });
    expect(seg.c2).toEqual({ x: 18, y: 4 });
    expect(seg.to).toEqual({ x: 20, y: 0 });
  });

  it('reflects the previous control point for smooth quadratics (T)', () => {
    const p = parsePathData('M0 0 Q 5 10 10 0 T 20 0');
    const seg = p.subpaths[0].segments[1] as Extract<PathSegment, { type: 'quad' }>;
    expect(seg.type).toBe('quad');
    expect(seg.control).toEqual({ x: 15, y: -10 });
    expect(seg.to).toEqual({ x: 20, y: 0 });
  });

  it('accepts the compact number syntax (no separators, chained decimals)', () => {
    const p = parsePathData('M0 0L1.5.5-1-2');
    expect(p.subpaths[0].segments).toEqual([
      { type: 'line', to: { x: 1.5, y: 0.5 } },
      { type: 'line', to: { x: -1, y: -2 } },
    ]);
  });

  it('converts an elliptical arc to cubic segments that hit the endpoint', () => {
    // Half-circle radius 10 from (0,0) to (20,0), sweeping downward.
    const p = parsePathData('M0 0 A 10 10 0 0 1 20 0');
    const segs = p.subpaths[0].segments;
    expect(segs.length).toBeGreaterThanOrEqual(2); // ≥90° → split
    for (const s of segs) expect(s.type).toBe('cubic');
    const last = segs[segs.length - 1] as Extract<PathSegment, { type: 'cubic' }>;
    expect(near(last.to.x, 20, 1e-4)).toBe(true);
    expect(near(last.to.y, 0, 1e-4)).toBe(true);
    // Sweep flag 1 parameterizes through θ=270° (centre at (10,0)), so the arc's
    // midpoint reaches y=-10; the opposite sweep mirrors it to y=+10.
    const mid1 = segs[0] as Extract<PathSegment, { type: 'cubic' }>;
    expect(near(mid1.to.y, -10, 1e-4)).toBe(true);
    const other = parsePathData('M0 0 A 10 10 0 0 0 20 0').subpaths[0].segments[0] as Extract<
      PathSegment,
      { type: 'cubic' }
    >;
    expect(near(other.to.y, 10, 1e-4)).toBe(true);
  });

  it('degenerate arc radii collapse to a line', () => {
    const p = parsePathData('M0 0 A 0 0 0 0 1 10 10');
    expect(p.subpaths[0].segments).toEqual([{ type: 'line', to: { x: 10, y: 10 } }]);
  });

  it('rejects path data that does not start with a moveto', () => {
    expect(() => parsePathData('L10 10')).toThrow();
  });
});
