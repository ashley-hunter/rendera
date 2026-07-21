/**
 * Linear-light ↔ sRGB hex conversion — the bridge between the engine's
 * `LinearRgba` paint model and the `#rrggbb` strings an HTML colour input speaks.
 *
 * The compositor works in linear light, but authoring tools (and CSS) work in
 * sRGB, so a colour picker must convert both ways through the exact sRGB transfer
 * function. Alpha is linear in both spaces and passes through untouched.
 */

import type { LinearRgba } from './render-list';

/** Exact linear-light → sRGB transfer for one 0–1 channel. */
function toSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Exact sRGB → linear-light transfer for one 0–1 channel. */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const byte = (c: number): string => Math.min(255, Math.max(0, Math.round(c * 255))).toString(16).padStart(2, '0');

/** A linear-light colour → `#rrggbb` (sRGB, alpha dropped). */
export function linearToHex(c: LinearRgba): string {
  return `#${byte(toSrgb(c.r))}${byte(toSrgb(c.g))}${byte(toSrgb(c.b))}`;
}

/**
 * Parse a `#rgb` / `#rrggbb` (optionally `#rgba` / `#rrggbbaa`) sRGB hex string
 * into a linear-light colour. `alpha` overrides the parsed/opaque alpha when
 * given (e.g. to keep an existing paint's alpha while only the RGB changes).
 */
export function hexToLinear(hex: string, alpha?: number): LinearRgba {
  const h = hex.replace('#', '').trim();
  const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16) / 255;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 1;
  if (h.length === 3 || h.length === 4) {
    r = expand(h[0]); g = expand(h[1]); b = expand(h[2]);
    if (h.length === 4) a = expand(h[3]);
  } else if (h.length === 6 || h.length === 8) {
    r = parseInt(h.slice(0, 2), 16) / 255;
    g = parseInt(h.slice(2, 4), 16) / 255;
    b = parseInt(h.slice(4, 6), 16) / 255;
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
  }
  return { r: toLinear(r), g: toLinear(g), b: toLinear(b), a: alpha ?? a };
}
