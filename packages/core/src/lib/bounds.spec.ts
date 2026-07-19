import {
  boundsCenter,
  boundsContainsPoint,
  boundsFromPoints,
  boundsFromRect,
  boundsHeight,
  boundsIntersect,
  boundsWidth,
  transformBounds,
  unionBounds,
} from './bounds';
import { fromRotation, fromTranslation } from './matrix';
import { vec2 } from './vec2';

describe('bounds basics', () => {
  it('derives extents, size and center from a rect', () => {
    const b = boundsFromRect(10, 20, 30, 40);
    expect(b).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 60 });
    expect(boundsWidth(b)).toBe(30);
    expect(boundsHeight(b)).toBe(40);
    expect(boundsCenter(b)).toEqual(vec2(25, 40));
  });

  it('builds bounds from a set of points', () => {
    const b = boundsFromPoints([vec2(1, 5), vec2(-2, 3), vec2(4, -1)]);
    expect(b).toEqual({ minX: -2, minY: -1, maxX: 4, maxY: 5 });
    expect(() => boundsFromPoints([])).toThrow();
  });

  it('unions and tests containment/intersection', () => {
    const a = boundsFromRect(0, 0, 10, 10);
    const b = boundsFromRect(5, 5, 10, 10);
    expect(unionBounds(a, b)).toEqual({ minX: 0, minY: 0, maxX: 15, maxY: 15 });
    expect(boundsContainsPoint(a, vec2(5, 5))).toBe(true);
    expect(boundsContainsPoint(a, vec2(20, 5))).toBe(false);
    expect(boundsIntersect(a, b)).toBe(true);
    expect(boundsIntersect(a, boundsFromRect(100, 100, 1, 1))).toBe(false);
  });
});

describe('transformBounds', () => {
  it('translates the axis-aligned box', () => {
    const b = boundsFromRect(0, 0, 10, 20);
    expect(transformBounds(fromTranslation(vec2(5, 7)), b)).toEqual({
      minX: 5,
      minY: 7,
      maxX: 15,
      maxY: 27,
    });
  });

  it('returns the AABB of a rotated box (dimensions swap on a quarter turn)', () => {
    const b = boundsFromRect(0, 0, 10, 20);
    const rotated = transformBounds(fromRotation(Math.PI / 2), b);
    expect(boundsWidth(rotated)).toBeCloseTo(20, 9);
    expect(boundsHeight(rotated)).toBeCloseTo(10, 9);
  });
});
