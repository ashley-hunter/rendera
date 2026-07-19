/**
 * 2D affine transforms (`Mat2D`).
 *
 * Stored as the six values `a, b, c, d, e, f`, matching `DOMMatrix`'s 2D form:
 *
 *     | a c e |        x' = a*x + c*y + e
 *     | b d f |        y' = b*x + d*y + f
 *     | 0 0 1 |
 *
 * Coordinates are y-down. Matrices are the *derived* representation of a
 * transform (ADR 0006): node transforms are authored as decomposed channels
 * (see `transform.ts`) and converted to a `Mat2D` for rendering and hit-testing.
 */

import { type Vec2, vec2 } from './vec2';

export interface Mat2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** The identity transform. */
export const IDENTITY: Mat2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function mat2d(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
): Mat2D {
  return { a, b, c, d, e, f };
}

export function fromTranslation(t: Vec2): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: t.x, f: t.y };
}

export function fromScaling(s: Vec2): Mat2D {
  return { a: s.x, b: 0, c: 0, d: s.y, e: 0, f: 0 };
}

/** Rotation by `radians`. In y-down space this turns +x toward +y. */
export function fromRotation(radians: number): Mat2D {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** Skew (shear) by the given angles in radians. `skewX` shears x by y. */
export function fromSkew(skewX: number, skewY = 0): Mat2D {
  return { a: 1, b: Math.tan(skewY), c: Math.tan(skewX), d: 1, e: 0, f: 0 };
}

/**
 * Matrix product `m1 * m2`. Applied to a point, `m2` acts first, then `m1`
 * (same convention as `DOMMatrix.multiply`).
 */
export function multiply(m1: Mat2D, m2: Mat2D): Mat2D {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/**
 * Compose a chain of transforms, folding left-to-right. The last argument is
 * applied to a point first, the first argument last — so
 * `compose(parent, child)` maps child-local coordinates to parent space.
 */
export function compose(...matrices: Mat2D[]): Mat2D {
  let result = IDENTITY;
  for (const m of matrices) {
    result = multiply(result, m);
  }
  return result;
}

export function determinant(m: Mat2D): number {
  return m.a * m.d - m.b * m.c;
}

/** Inverse transform, or `null` if the matrix is singular. */
export function invert(m: Mat2D): Mat2D | null {
  const det = determinant(m);
  if (det === 0) {
    return null;
  }
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
}

/** Apply the full transform (including translation) to a point. */
export function transformPoint(m: Mat2D, p: Vec2): Vec2 {
  return vec2(m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f);
}

/** Apply only the linear part (ignoring translation) to a vector. */
export function transformVector(m: Mat2D, v: Vec2): Vec2 {
  return vec2(m.a * v.x + m.c * v.y, m.b * v.x + m.d * v.y);
}

export function approxEquals(m1: Mat2D, m2: Mat2D, epsilon = 1e-9): boolean {
  return (
    Math.abs(m1.a - m2.a) <= epsilon &&
    Math.abs(m1.b - m2.b) <= epsilon &&
    Math.abs(m1.c - m2.c) <= epsilon &&
    Math.abs(m1.d - m2.d) <= epsilon &&
    Math.abs(m1.e - m2.e) <= epsilon &&
    Math.abs(m1.f - m2.f) <= epsilon
  );
}
