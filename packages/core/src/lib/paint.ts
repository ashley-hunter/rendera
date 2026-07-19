/**
 * Paint model — how a fill or stroke is coloured.
 *
 * The simplest paint is a flat `solid`. Beyond that a shape can be painted with
 * a gradient: a ramp of colour `stops` swept along a geometry (a line for
 * `linear`, a pair of circles for `radial`, an angle for `conic`). Gradient
 * geometry is expressed in the paint target's **local** space — the same space
 * the path's geometry is authored in — so a gradient transforms exactly with
 * its shape under any affine (rotate a gradient-filled rectangle and the ramp
 * rotates with it; scale it non-uniformly and the ramp shears correctly). The
 * backend rasterizes gradients analytically per pixel (ADR 0007), so they stay
 * band-free and resolution-independent at any zoom.
 *
 * Being plain data, this is fully serializable and unit-tested with no GPU.
 */

import type { LinearRgba } from './render-list';
import type { Vec2 } from './vec2';

/** One colour stop of a gradient: a linear-light colour at an offset in [0, 1]. */
export interface GradientStop {
  /** Position along the ramp, in [0, 1]. */
  readonly offset: number;
  /** Linear-light colour at this offset. */
  readonly color: LinearRgba;
}

/**
 * What happens outside the gradient's [0, 1] parameter range:
 * - `pad` (default): clamp to the first/last stop.
 * - `repeat`: tile the ramp.
 * - `reflect`: tile, mirroring every other repeat.
 */
export type SpreadMode = 'pad' | 'repeat' | 'reflect';

/**
 * The colour space stops interpolate through:
 * - `linear` (default): linear-light RGB — physically correct for compositing,
 *   matches our premultiplied pipeline.
 * - `oklab`: perceptually uniform — smoother hue ramps with no muddy midpoints.
 */
export type InterpolationSpace = 'linear' | 'oklab';

/** Fields shared by every gradient. */
interface GradientBase {
  readonly stops: readonly GradientStop[];
  /** Behaviour outside [0, 1] (default `pad`). */
  readonly spread?: SpreadMode;
  /** Interpolation colour space (default `linear`). */
  readonly interpolation?: InterpolationSpace;
}

/** A linear gradient: the ramp runs along the axis from `start` to `end`. */
export interface LinearGradient extends GradientBase {
  readonly type: 'linear-gradient';
  /** Ramp origin (offset 0), local space. */
  readonly start: Vec2;
  /** Ramp end (offset 1), local space. */
  readonly end: Vec2;
}

/**
 * A radial gradient in the two-circle (Canvas/CSS) model: the ramp interpolates
 * between a `start` circle (offset 0) and an `end` circle (offset 1). Equal
 * centres give a plain concentric gradient; offset centres give a focal
 * highlight. A zero-radius `start` at the `end` centre is the common "glow".
 */
export interface RadialGradient extends GradientBase {
  readonly type: 'radial-gradient';
  readonly start: { readonly center: Vec2; readonly radius: number };
  readonly end: { readonly center: Vec2; readonly radius: number };
}

/** A conic (angular) gradient sweeping around `center` from `angle` (radians). */
export interface ConicGradient extends GradientBase {
  readonly type: 'conic-gradient';
  readonly center: Vec2;
  /** Start angle in radians, measured from +x, clockwise in screen space
   * (default 0). */
  readonly angle?: number;
}

/** Any gradient paint. */
export type Gradient = LinearGradient | RadialGradient | ConicGradient;

/** A flat colour paint. */
export interface SolidPaint {
  readonly type: 'solid';
  readonly color: LinearRgba;
}

/** How a fill or stroke is painted: a flat colour or a gradient. */
export type Paint = SolidPaint | Gradient;

/** Numeric paint-kind tags shared by the backend packing and shaders. */
export const PAINT_SOLID = 0;
export const PAINT_LINEAR = 1;
export const PAINT_RADIAL = 2;
export const PAINT_CONIC = 3;

/** The backend's numeric tag for a paint's kind. */
export function paintKind(paint: Paint): number {
  switch (paint.type) {
    case 'linear-gradient':
      return PAINT_LINEAR;
    case 'radial-gradient':
      return PAINT_RADIAL;
    case 'conic-gradient':
      return PAINT_CONIC;
    default:
      return PAINT_SOLID;
  }
}

/** Numeric tag for a spread mode (shared with the shader). */
export function spreadIndex(spread: SpreadMode | undefined): number {
  return spread === 'repeat' ? 1 : spread === 'reflect' ? 2 : 0;
}

/**
 * Normalize a gradient's stops for the backend: sorted by offset, clamped to
 * [0, 1], each offset made monotonic (never less than the previous). A gradient
 * with no stops yields a single transparent stop; a single stop is duplicated
 * so the backend always has a well-formed two-endpoint ramp.
 */
export function normalizedStops(stops: readonly GradientStop[]): GradientStop[] {
  const clamped = stops
    .map((s) => ({ offset: Math.min(1, Math.max(0, s.offset)), color: s.color }))
    .sort((a, b) => a.offset - b.offset);
  if (clamped.length === 0) {
    const clear: LinearRgba = { r: 0, g: 0, b: 0, a: 0 };
    return [
      { offset: 0, color: clear },
      { offset: 1, color: clear },
    ];
  }
  // Make offsets monotonic (a later stop never precedes an earlier one).
  for (let i = 1; i < clamped.length; i++) {
    if (clamped[i].offset < clamped[i - 1].offset) {
      clamped[i] = { ...clamped[i], offset: clamped[i - 1].offset };
    }
  }
  if (clamped.length === 1) {
    return [
      { offset: 0, color: clamped[0].color },
      { offset: 1, color: clamped[0].color },
    ];
  }
  return clamped;
}

/**
 * The gradient's ramp colour at parameter `t` (before spread is applied),
 * interpolated in the gradient's colour space. A pure-CPU mirror of the shader,
 * useful for tests and any headless colour queries. `t` is clamped to [0, 1];
 * callers apply spread beforehand if they want repeat/reflect.
 */
export function sampleRamp(g: Gradient, t: number): LinearRgba {
  const stops = normalizedStops(g.stops);
  const u = Math.min(1, Math.max(0, t));
  let hi = 1;
  while (hi < stops.length - 1 && stops[hi].offset < u) {
    hi++;
  }
  const a = stops[hi - 1];
  const b = stops[hi];
  const span = b.offset - a.offset;
  const f = span > 1e-9 ? (u - a.offset) / span : 0;
  if (g.interpolation === 'oklab') {
    return oklabMix(a.color, b.color, f);
  }
  return {
    r: a.color.r + (b.color.r - a.color.r) * f,
    g: a.color.g + (b.color.g - a.color.g) * f,
    b: a.color.b + (b.color.b - a.color.b) * f,
    a: a.color.a + (b.color.a - a.color.a) * f,
  };
}

/** Linear-sRGB → OKLab (Björn Ottosson). Input/mix/output are linear-light. */
function linearToOklab(c: LinearRgba): [number, number, number] {
  const l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  const m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  const s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

/** OKLab → linear-sRGB (inverse of `linearToOklab`). */
function oklabToLinear(L: number, A: number, B: number): [number, number, number] {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Mix two linear-light colours through OKLab; alpha mixes linearly. */
function oklabMix(c0: LinearRgba, c1: LinearRgba, f: number): LinearRgba {
  const [l0, a0, b0] = linearToOklab(c0);
  const [l1, a1, b1] = linearToOklab(c1);
  const [r, g, b] = oklabToLinear(
    l0 + (l1 - l0) * f,
    a0 + (a1 - a0) * f,
    b0 + (b1 - b0) * f
  );
  return { r, g, b, a: c0.a + (c1.a - c0.a) * f };
}
