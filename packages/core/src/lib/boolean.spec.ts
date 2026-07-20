import { booleanPath } from './boolean';
import { ellipsePath, pointInPath, rectPath, type Path } from './path';
import { vec2 } from './vec2';

/** Two circles (r=10) at (0,0) and (8,0): overlap around x≈4. */
const A: Path = ellipsePath(0, 0, 10, 10);
const B: Path = ellipsePath(8, 0, 10, 10);

const inside = (p: Path, x: number, y: number): boolean => pointInPath(p, vec2(x, y), 'nonzero');

describe('booleanPath (circles)', () => {
  it('union covers both, excludes outside', () => {
    const u = booleanPath(A, B, 'union');
    expect(inside(u, -8, 0)).toBe(true); // A only
    expect(inside(u, 16, 0)).toBe(true); // B only
    expect(inside(u, 4, 0)).toBe(true); // overlap
    expect(inside(u, 40, 0)).toBe(false); // outside both
    expect(inside(u, 0, 40)).toBe(false);
  });

  it('intersect keeps only the overlap', () => {
    const i = booleanPath(A, B, 'intersect');
    expect(inside(i, 4, 0)).toBe(true); // overlap
    expect(inside(i, -8, 0)).toBe(false); // A only
    expect(inside(i, 16, 0)).toBe(false); // B only
  });

  it('difference (A−B) keeps A minus the overlap', () => {
    const d = booleanPath(A, B, 'difference');
    expect(inside(d, -8, 0)).toBe(true); // A only
    expect(inside(d, 4, 0)).toBe(false); // overlap removed
    expect(inside(d, 16, 0)).toBe(false); // B only, never in A
  });

  it('xor keeps both minus the overlap', () => {
    const x = booleanPath(A, B, 'xor');
    expect(inside(x, -8, 0)).toBe(true); // A only
    expect(inside(x, 16, 0)).toBe(true); // B only
    expect(inside(x, 4, 0)).toBe(false); // overlap excluded
  });
});

describe('booleanPath (rectangles / lines)', () => {
  // Two squares overlapping in a corner region [5,10]×[5,10].
  const R1 = rectPath(0, 0, 10, 10);
  const R2 = rectPath(5, 5, 10, 10);

  it('union of overlapping squares', () => {
    const u = booleanPath(R1, R2, 'union');
    expect(inside(u, 2, 2)).toBe(true); // R1 only
    expect(inside(u, 13, 13)).toBe(true); // R2 only
    expect(inside(u, 7, 7)).toBe(true); // overlap
    expect(inside(u, 2, 13)).toBe(false); // outside both (top-left gap)
  });

  it('intersect of overlapping squares is the shared corner', () => {
    const i = booleanPath(R1, R2, 'intersect');
    expect(inside(i, 7, 7)).toBe(true);
    expect(inside(i, 2, 2)).toBe(false);
    expect(inside(i, 13, 13)).toBe(false);
  });

  it('difference removes the shared corner from R1', () => {
    const d = booleanPath(R1, R2, 'difference');
    expect(inside(d, 2, 2)).toBe(true); // R1 only
    expect(inside(d, 7, 7)).toBe(false); // shared corner removed
    expect(inside(d, 13, 13)).toBe(false); // R2 only
  });
});

describe('booleanPath (disjoint / contained)', () => {
  it('union of disjoint shapes keeps both', () => {
    const far = ellipsePath(100, 0, 5, 5);
    const u = booleanPath(A, far, 'union');
    expect(inside(u, 0, 0)).toBe(true);
    expect(inside(u, 100, 0)).toBe(true);
    expect(inside(u, 50, 0)).toBe(false);
  });

  it('intersect of disjoint shapes is empty', () => {
    const far = ellipsePath(100, 0, 5, 5);
    const i = booleanPath(A, far, 'intersect');
    expect(inside(i, 0, 0)).toBe(false);
    expect(inside(i, 100, 0)).toBe(false);
  });
});
