import { shapeToPath, withRadius, withSides, type PolygonShape, type RectShape } from './shape';

describe('shapeToPath (rect)', () => {
  it('is a plain rectangle at radius 0 (4 corners, all line segments)', () => {
    const path = shapeToPath({ kind: 'rect', width: 40, height: 30, radius: 0 });
    const sub = path.subpaths[0];
    expect(sub.start).toEqual({ x: 0, y: 0 });
    expect(sub.segments.every((s) => s.type === 'line')).toBe(true);
  });

  it('rounds the corners with a radius (introduces curves, clamped to half the short side)', () => {
    const path = shapeToPath({ kind: 'rect', width: 40, height: 30, radius: 8 });
    const sub = path.subpaths[0];
    expect(sub.segments.some((s) => s.type === 'cubic')).toBe(true);
    // A radius larger than half the shorter side still produces a valid path.
    expect(() => shapeToPath({ kind: 'rect', width: 40, height: 30, radius: 999 })).not.toThrow();
  });
});

describe('shapeToPath (polygon)', () => {
  it('has one vertex per side', () => {
    const path = shapeToPath({ kind: 'polygon', cx: 50, cy: 50, radius: 50, sides: 6, rotation: 0 });
    const sub = path.subpaths[0];
    // start + (sides - 1) line segments = `sides` vertices, closed.
    expect(sub.segments).toHaveLength(5);
    expect(sub.closed).toBe(true);
  });

  it('puts the first vertex straight up (−90°) by default', () => {
    const path = shapeToPath({ kind: 'polygon', cx: 100, cy: 100, radius: 40, sides: 4, rotation: 0 });
    expect(path.subpaths[0].start.x).toBeCloseTo(100); // directly above centre
    expect(path.subpaths[0].start.y).toBeCloseTo(60);
  });

  it('clamps sides to at least 3', () => {
    const path = shapeToPath({ kind: 'polygon', cx: 0, cy: 0, radius: 10, sides: 1, rotation: 0 });
    expect(path.subpaths[0].segments).toHaveLength(2); // 3 vertices
  });
});

describe('withRadius / withSides', () => {
  it('clamps radius to >= 0 and sides to >= 3 (rounded)', () => {
    const rect: RectShape = { kind: 'rect', width: 10, height: 10, radius: 2 };
    expect(withRadius(rect, -5).radius).toBe(0);
    expect(withRadius(rect, 4).radius).toBe(4);
    const poly: PolygonShape = { kind: 'polygon', cx: 0, cy: 0, radius: 5, sides: 5, rotation: 0 };
    expect(withSides(poly, 2).sides).toBe(3);
    expect(withSides(poly, 6.7).sides).toBe(7);
  });
});
