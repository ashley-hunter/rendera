import { pathHandleLines, pathPoints, setPathPoint } from './path-edit';
import type { Path } from './path';
import { rectPath } from './path';

// A single cubic segment from (0,0) to (100,0), controls above.
const cubic: Path = {
  subpaths: [{ start: { x: 0, y: 0 }, closed: false, segments: [{ type: 'cubic', c1: { x: 30, y: -40 }, c2: { x: 70, y: -40 }, to: { x: 100, y: 0 } }] }],
};
const quad: Path = {
  subpaths: [{ start: { x: 0, y: 0 }, closed: false, segments: [{ type: 'quad', control: { x: 50, y: -50 }, to: { x: 100, y: 0 } }] }],
};

describe('pathPoints', () => {
  it('enumerates a rectangle as four on-curve anchors', () => {
    const pts = pathPoints(rectPath(0, 0, 10, 10));
    expect(pts).toHaveLength(4); // start + 3 line `to`s (close is implicit)
    expect(pts.every((p) => p.anchor)).toBe(true);
    expect(pts[0].ref).toEqual({ sub: 0, kind: 'start' });
    expect(pts[0].point).toEqual({ x: 0, y: 0 });
  });

  it('exposes a cubic segment as c1, c2 (controls) and to (anchor)', () => {
    const pts = pathPoints(cubic);
    expect(pts.map((p) => [p.ref.kind, p.anchor])).toEqual([
      ['start', true], ['c1', false], ['c2', false], ['to', true],
    ]);
    expect(pts[1].point).toEqual({ x: 30, y: -40 });
  });
});

describe('setPathPoint', () => {
  it('moves an anchor immutably', () => {
    const p = rectPath(0, 0, 10, 10);
    const moved = setPathPoint(p, { sub: 0, kind: 'start' }, { x: -5, y: -5 });
    expect(moved.subpaths[0].start).toEqual({ x: -5, y: -5 });
    expect(p.subpaths[0].start).toEqual({ x: 0, y: 0 }); // original untouched
  });

  it('moves a cubic control point', () => {
    const moved = setPathPoint(cubic, { sub: 0, seg: 0, kind: 'c2' }, { x: 80, y: 10 });
    const seg = moved.subpaths[0].segments[0];
    expect(seg.type === 'cubic' && seg.c2).toEqual({ x: 80, y: 10 });
    expect(seg.type === 'cubic' && seg.c1).toEqual({ x: 30, y: -40 }); // c1 unchanged
  });

  it('moves a line endpoint', () => {
    const moved = setPathPoint(rectPath(0, 0, 10, 10), { sub: 0, seg: 0, kind: 'to' }, { x: 20, y: 0 });
    expect(moved.subpaths[0].segments[0]).toEqual({ type: 'line', to: { x: 20, y: 0 } });
  });
});

describe('pathHandleLines', () => {
  it('links a cubic control to its adjacent anchor', () => {
    const lines = pathHandleLines(cubic);
    expect(lines).toEqual([
      { from: { x: 0, y: 0 }, to: { x: 30, y: -40 } }, // start → c1
      { from: { x: 100, y: 0 }, to: { x: 70, y: -40 } }, // to → c2
    ]);
  });

  it('links a quad control to both endpoints', () => {
    const lines = pathHandleLines(quad);
    expect(lines).toEqual([
      { from: { x: 0, y: 0 }, to: { x: 50, y: -50 } },
      { from: { x: 100, y: 0 }, to: { x: 50, y: -50 } },
    ]);
  });

  it('has no handle lines for an all-line path', () => {
    expect(pathHandleLines(rectPath(0, 0, 10, 10))).toEqual([]);
  });
});
