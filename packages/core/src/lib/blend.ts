/**
 * Blend modes — the W3C Compositing and Blending Level 1 set.
 *
 * The model only names the mode; the actual blend maths run in the backend
 * compositor, in linear light, reading the backdrop (ADR 0003). The array order
 * is the canonical index order and MUST match the renderer's blend shader
 * switch — `blendModeIndex` is the single source of truth for that mapping.
 */

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/** All blend modes in canonical (shader-index) order. */
export const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

/** The numeric index the backend uses for a blend mode (0 = normal). */
export function blendModeIndex(mode: BlendMode): number {
  return BLEND_MODES.indexOf(mode);
}

/** The separable modes are per-channel; the non-separable four are not. */
export function isSeparable(mode: BlendMode): boolean {
  return mode !== 'hue' && mode !== 'saturation' && mode !== 'color' && mode !== 'luminosity';
}
