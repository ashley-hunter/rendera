import { parseTransform } from './transform-attr';
import { matrixToTransform, toMatrix } from '../transform';
import { transformPoint, type Mat2D } from '../matrix';

const nearM = (a: Mat2D, b: Mat2D, eps = 1e-9): boolean =>
  Math.abs(a.a - b.a) <= eps &&
  Math.abs(a.b - b.b) <= eps &&
  Math.abs(a.c - b.c) <= eps &&
  Math.abs(a.d - b.d) <= eps &&
  Math.abs(a.e - b.e) <= eps &&
  Math.abs(a.f - b.f) <= eps;

describe('parseTransform', () => {
  it('parses translate with an implicit zero y', () => {
    expect(parseTransform('translate(10)')).toMatchObject({ e: 10, f: 0 });
    expect(parseTransform('translate(10, 20)')).toMatchObject({ e: 10, f: 20 });
  });

  it('parses scale with an implicit uniform y', () => {
    expect(parseTransform('scale(2)')).toMatchObject({ a: 2, d: 2 });
    expect(parseTransform('scale(2, 3)')).toMatchObject({ a: 2, d: 3 });
  });

  it('composes a list left-to-right (leftmost outermost)', () => {
    // translate then rotate: a point at the origin maps to the translation.
    const m = parseTransform('translate(50 0) rotate(90)');
    const p = transformPoint(m, { x: 0, y: 0 });
    expect(Math.abs(p.x - 50)).toBeLessThan(1e-9);
    expect(Math.abs(p.y - 0)).toBeLessThan(1e-9);
    // (1,0) rotates to (0,1) then shifts by (50,0) -> (50,1).
    const q = transformPoint(m, { x: 1, y: 0 });
    expect(Math.abs(q.x - 50)).toBeLessThan(1e-9);
    expect(Math.abs(q.y - 1)).toBeLessThan(1e-9);
  });

  it('rotates about a centre point', () => {
    const m = parseTransform('rotate(180 10 10)');
    const p = transformPoint(m, { x: 10, y: 10 });
    expect(Math.abs(p.x - 10)).toBeLessThan(1e-9); // centre is fixed
    expect(Math.abs(p.y - 10)).toBeLessThan(1e-9);
  });

  it('parses a raw matrix()', () => {
    expect(parseTransform('matrix(1 2 3 4 5 6)')).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
  });

  it('returns identity for an empty transform', () => {
    expect(parseTransform('')).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });
});

describe('matrixToTransform round-trips through toMatrix', () => {
  const cases: Mat2D[] = [
    { a: 1, b: 0, c: 0, d: 1, e: 7, f: -3 }, // translate
    { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 }, // non-uniform scale
    parseTransform('rotate(37)'),
    parseTransform('translate(4 5) rotate(20) scale(1.5 0.5)'),
    parseTransform('skewX(15)'),
    parseTransform('matrix(1 0.4 0.2 1 3 2)'),
    { a: -1, b: 0, c: 0, d: 1, e: 2, f: 2 }, // reflection (negative determinant)
  ];
  it.each(cases.map((m, i) => [i, m] as const))('case %i', (_i, m) => {
    expect(nearM(toMatrix(matrixToTransform(m)), m)).toBe(true);
  });
});
