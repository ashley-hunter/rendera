import { SceneDocument } from './document';
import { ellipseShape, isDrawnBigEnough, polygonShape, polylineShape, rectShape } from './draw';
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
