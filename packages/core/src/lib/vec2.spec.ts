import {
  add,
  approxEquals,
  distance,
  dot,
  length,
  lengthSquared,
  lerp,
  negate,
  normalize,
  scale,
  subtract,
  vec2,
} from './vec2';

describe('vec2 arithmetic', () => {
  it('adds, subtracts, scales and negates', () => {
    expect(add(vec2(1, 2), vec2(3, 4))).toEqual(vec2(4, 6));
    expect(subtract(vec2(3, 4), vec2(1, 2))).toEqual(vec2(2, 2));
    expect(scale(vec2(2, -3), 2)).toEqual(vec2(4, -6));
    expect(negate(vec2(2, -3))).toEqual(vec2(-2, 3));
  });

  it('computes dot, length and distance', () => {
    expect(dot(vec2(1, 2), vec2(3, 4))).toBe(11);
    expect(lengthSquared(vec2(3, 4))).toBe(25);
    expect(length(vec2(3, 4))).toBe(5);
    expect(distance(vec2(0, 0), vec2(3, 4))).toBe(5);
  });

  it('normalizes to unit length and handles the zero vector', () => {
    const n = normalize(vec2(0, 5));
    expect(approxEquals(n, vec2(0, 1))).toBe(true);
    expect(normalize(vec2(0, 0))).toEqual(vec2(0, 0));
  });

  it('lerps between two vectors', () => {
    expect(lerp(vec2(0, 0), vec2(10, 20), 0.5)).toEqual(vec2(5, 10));
    expect(lerp(vec2(0, 0), vec2(10, 20), 0)).toEqual(vec2(0, 0));
    expect(lerp(vec2(0, 0), vec2(10, 20), 1)).toEqual(vec2(10, 20));
  });

  it('compares with a tolerance', () => {
    expect(approxEquals(vec2(1, 1), vec2(1 + 1e-12, 1))).toBe(true);
    expect(approxEquals(vec2(1, 1), vec2(1.1, 1))).toBe(false);
  });
});
