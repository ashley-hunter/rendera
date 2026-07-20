/**
 * SVG `transform` attribute parser (SVG 1.1 §7.6) — owned, dependency-free.
 *
 * Parses a whitespace/comma-separated list of `matrix`, `translate`, `scale`,
 * `rotate`, `skewX`, and `skewY` functions and composes them left-to-right into
 * a single affine `Mat2D` (the leftmost function is outermost, matching SVG's
 * "apply the rightmost to the geometry first" semantics). Angles are in degrees.
 * An empty or absent list yields the identity.
 */

import {
  compose,
  fromRotation,
  fromScaling,
  fromTranslation,
  fromSkew,
  IDENTITY,
  mat2d,
  type Mat2D,
} from '../matrix';
import { vec2 } from '../vec2';

const DEG = Math.PI / 180;

function fnMatrix(name: string, args: number[]): Mat2D {
  switch (name) {
    case 'matrix':
      if (args.length !== 6) throw new Error('matrix() needs 6 values');
      return mat2d(args[0], args[1], args[2], args[3], args[4], args[5]);
    case 'translate':
      return fromTranslation(vec2(args[0] ?? 0, args[1] ?? 0));
    case 'scale':
      return fromScaling(vec2(args[0] ?? 1, args[1] ?? args[0] ?? 1));
    case 'rotate': {
      const r = fromRotation((args[0] ?? 0) * DEG);
      if (args.length >= 3) {
        // rotate about (cx, cy).
        return compose(fromTranslation(vec2(args[1], args[2])), r, fromTranslation(vec2(-args[1], -args[2])));
      }
      return r;
    }
    case 'skewX':
      return fromSkew((args[0] ?? 0) * DEG, 0);
    case 'skewY':
      return fromSkew(0, (args[0] ?? 0) * DEG);
    default:
      throw new Error(`unknown transform function ${name}()`);
  }
}

/** Parse an SVG `transform` attribute into a composed affine matrix. */
export function parseTransform(value: string): Mat2D {
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  const parts: Mat2D[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const name = m[1];
    const args = m[2]
      .split(/[\s,]+/)
      .filter((t) => t !== '')
      .map((t) => {
        const num = Number(t);
        if (Number.isNaN(num)) throw new Error(`invalid number "${t}" in transform`);
        return num;
      });
    parts.push(fnMatrix(name, args));
  }
  if (parts.length === 0) return IDENTITY;
  return compose(...parts);
}
