/**
 * sRGB transfer functions (ADR 0003).
 *
 * The Display-P3 output space shares this same transfer curve; only the
 * primaries differ, which matters for chromatic colours (handled when coloured
 * content is rendered). These scalar helpers are the CPU-side reference that
 * the present shader's `linearToSrgb` mirrors, so tests can predict encoded
 * output.
 */

/** Encode a linear-light value in [0,1] to its sRGB-encoded value. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Decode an sRGB-encoded value in [0,1] to linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Quantize a [0,1] value to an 8-bit unorm byte (clamped, rounded). */
export function encode8(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}
