/**
 * 2D vectors — immutable value type and pure operations.
 *
 * Coordinates are y-down (matching DOM/canvas). Vectors are plain `{ x, y }`
 * objects so they serialize trivially and compare structurally.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** The zero vector. */
export const ZERO: Vec2 = { x: 0, y: 0 };

/** Construct a vector. */
export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function negate(a: Vec2): Vec2 {
  return { x: -a.x, y: -a.y };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function lengthSquared(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export function length(a: Vec2): number {
  return Math.sqrt(lengthSquared(a));
}

export function distance(a: Vec2, b: Vec2): number {
  return length(subtract(a, b));
}

/** Unit vector in the direction of `a`; returns the zero vector if `a` is zero. */
export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  return len === 0 ? ZERO : { x: a.x / len, y: a.y / len };
}

/** Linear interpolation from `a` to `b` at parameter `t`. */
export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Exact structural equality. */
export function equals(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Equality within a tolerance (default 1e-9). */
export function approxEquals(a: Vec2, b: Vec2, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}
