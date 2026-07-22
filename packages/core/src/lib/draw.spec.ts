import { bezierShape, ellipseShape, isDrawnBigEnough, penPath, polygonShape, polylineShape, rectShape } from './draw';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import type { PathNode } from './node';
import { vec2 } from './vec2';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });

describe('rectShape', () => {
  it('spans the drag corners regardless of direction, positioned by translation', () => {
    // Drag bottom-right → top-left; the box normalizes.
    const input = rectShape(vec2(120, 90), vec2(20, 30));
    expect(input.type).toBe('path');
    expect(input.transform!.translation).toEqual({ x: 20, y: 30 });
    // Inserting it gives world bounds matching the drag box.
    const d = doc();
    const n = d.insert<PathNode>(input);
    expect(d.getWorldBounds(n.id)).toEqual({ minX: 20, minY: 30, maxX: 120, maxY: 90 });
    expect((n.fill as { type: string }).type).toBe('solid'); // default paint
  });

  it('carries a live rect shape recipe (for corner-radius editing)', () => {
    const input = rectShape(vec2(0, 0), vec2(40, 30));
    expect(input.shape).toEqual({ kind: 'rect', width: 40, height: 30, radius: 0 });
  });
});

describe('polygonShape', () => {
  it('inscribes a regular polygon in the drag box with a live recipe', () => {
    const input = polygonShape(vec2(0, 0), vec2(100, 80), 5);
    expect(input.shape).toEqual({ kind: 'polygon', cx: 50, cy: 40, radius: 40, sides: 5, rotation: 0 });
    const d = doc();
    const n = d.insert<PathNode>(input);
    // 5 vertices → start + 4 line segments, closed.
    expect(n.path.subpaths[0].segments).toHaveLength(4);
  });
});

describe('ellipseShape', () => {
  it('is inscribed in the drag box', () => {
    const d = doc();
    const n = d.insert<PathNode>(ellipseShape(vec2(0, 0), vec2(80, 40)));
    const b = d.getWorldBounds(n.id)!;
    expect(b.minX).toBeCloseTo(0);
    expect(b.minY).toBeCloseTo(0);
    expect(b.maxX).toBeCloseTo(80);
    expect(b.maxY).toBeCloseTo(40);
  });
});

describe('polylineShape', () => {
  it('builds a closed polygon relative to the first point', () => {
    const input = polylineShape([vec2(10, 10), vec2(60, 10), vec2(60, 50)], true);
    expect(input.transform!.translation).toEqual({ x: 10, y: 10 });
    const sub = input.path.subpaths[0];
    expect(sub.closed).toBe(true);
    expect(sub.start).toEqual({ x: 0, y: 0 }); // first point at local origin
    expect(sub.segments).toHaveLength(2); // 3 points → start + 2 line segments
    expect(sub.segments[0]).toEqual({ type: 'line', to: { x: 50, y: 0 } });
  });

  it('builds an open stroked path when not closed', () => {
    const input = polylineShape([vec2(0, 0), vec2(30, 0)], false, {
      stroke: { paint: { type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }, width: 2 },
    });
    expect(input.path.subpaths[0].closed).toBe(false);
    expect(input.fill).toBeUndefined(); // stroke-only, no default fill
    expect(input.stroke!.width).toBe(2);
  });
});

describe('isDrawnBigEnough', () => {
  it('rejects a stray click and accepts a real drag', () => {
    expect(isDrawnBigEnough(vec2(0, 0), vec2(1, 1))).toBe(false);
    expect(isDrawnBigEnough(vec2(0, 0), vec2(10, 10))).toBe(true);
  });
});

describe('penPath', () => {
  it('makes line segments between handle-less nodes', () => {
    const path = penPath([{ point: vec2(0, 0) }, { point: vec2(10, 0) }, { point: vec2(10, 10) }], false);
    const sub = path.subpaths[0];
    expect(sub.segments.map((s) => s.type)).toEqual(['line', 'line']);
    expect(sub.closed).toBe(false);
  });

  it('makes a cubic when either endpoint has a handle facing the segment', () => {
    const path = penPath([{ point: vec2(0, 0), handleOut: vec2(5, -8) }, { point: vec2(20, 0), handleIn: vec2(15, -8) }], false);
    const seg = path.subpaths[0].segments[0];
    expect(seg).toEqual({ type: 'cubic', c1: { x: 5, y: -8 }, c2: { x: 15, y: -8 }, to: { x: 20, y: 0 } });
  });

  it('adds the wrap-around segment when closed', () => {
    const path = penPath([{ point: vec2(0, 0) }, { point: vec2(10, 0) }, { point: vec2(5, 10) }], true);
    expect(path.subpaths[0].segments).toHaveLength(3); // 2 between + 1 closing
    expect(path.subpaths[0].closed).toBe(true);
  });

  it('degenerates gracefully for 0 or 1 nodes', () => {
    expect(penPath([], false).subpaths).toEqual([]);
    expect(penPath([{ point: vec2(3, 4) }], false).subpaths[0]).toEqual({ start: { x: 3, y: 4 }, closed: false, segments: [] });
  });
});

describe('bezierShape', () => {
  it('localizes nodes + handles relative to the first point', () => {
    const input = bezierShape(
      [{ point: vec2(10, 10), handleOut: vec2(20, 5) }, { point: vec2(50, 10), handleIn: vec2(40, 5) }],
      false,
      { stroke: { paint: { type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }, width: 2 } }
    );
    expect(input.transform!.translation).toEqual({ x: 10, y: 10 });
    const seg = input.path.subpaths[0].segments[0];
    // Points shifted by (−10,−10): start (0,0), c1 (10,-5), c2 (30,-5), to (40,0).
    expect(seg).toEqual({ type: 'cubic', c1: { x: 10, y: -5 }, c2: { x: 30, y: -5 }, to: { x: 40, y: 0 } });
    expect(input.fill).toBeUndefined(); // stroke-only
  });
});
