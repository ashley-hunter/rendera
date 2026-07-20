/**
 * CSS/SVG colour parser → linear-light RGBA — owned, dependency-free.
 *
 * SVG colours are authored in sRGB; rendera's paint model stores linear-light
 * `LinearRgba` (the compositor works in linear light). This module parses every
 * common syntax — `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`, `rgb()/rgba()` (0–255 or
 * %), `hsl()/hsla()`, the full CSS named-colour table, `transparent`, and
 * `currentColor` — and converts through the exact sRGB transfer function. It
 * returns `null` for the keyword `none` (paint explicitly removed) so callers
 * can distinguish "no paint" from "black".
 */

import type { LinearRgba } from '../render-list';

/** Exact sRGB → linear-light transfer for one 0–1 channel. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linear(r: number, g: number, b: number, a: number): LinearRgba {
  return { r: srgbToLinear(r), g: srgbToLinear(g), b: srgbToLinear(b), a };
}

/** The 147 CSS Color Module named colours (sRGB hex, no alpha). */
const NAMED: Record<string, number> = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4, azure: 0xf0ffff,
  beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000, blanchedalmond: 0xffebcd, blue: 0x0000ff,
  blueviolet: 0x8a2be2, brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00,
  chocolate: 0xd2691e, coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9,
  darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f,
  darkorange: 0xff8c00, darkorchid: 0x9932cc, darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f,
  darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1,
  darkviolet: 0x9400d3, deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969,
  dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22, fuchsia: 0xff00ff,
  gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700, goldenrod: 0xdaa520, gray: 0x808080,
  green: 0x008000, greenyellow: 0xadff2f, grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4,
  indianred: 0xcd5c5c, indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6, lightcoral: 0xf08080,
  lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3, lightgreen: 0x90ee90,
  lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a, lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa,
  lightslategray: 0x778899, lightslategrey: 0x778899, lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0,
  lime: 0x00ff00, limegreen: 0x32cd32, linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000,
  mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db,
  mediumseagreen: 0x3cb371, mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5,
  navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6, olive: 0x808000, olivedrab: 0x6b8e23,
  orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98,
  paleturquoise: 0xafeeee, palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f,
  pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399,
  red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513, salmon: 0xfa8072,
  sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee, sienna: 0xa0522d, silver: 0xc0c0c0,
  skyblue: 0x87ceeb, slateblue: 0x6a5acd, slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa,
  springgreen: 0x00ff7f, steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080, thistle: 0xd8bfd8,
  tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff,
  whitesmoke: 0xf5f5f5, yellow: 0xffff00, yellowgreen: 0x9acd32,
};

function fromHexInt(hex: number, a = 1): LinearRgba {
  return linear(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, a);
}

/** Parse a `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` hex colour. */
function parseHex(s: string): LinearRgba | undefined {
  const h = s.slice(1);
  const expand = (c: string): number => parseInt(c + c, 16) / 255;
  if (h.length === 3 || h.length === 4) {
    const a = h.length === 4 ? expand(h[3]) : 1;
    return linear(expand(h[0]), expand(h[1]), expand(h[2]), a);
  }
  if (h.length === 6 || h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return linear(r, g, b, a);
  }
  return undefined;
}

/** Split a function body into tokens (comma, whitespace, or `/` separated). */
function tokens(body: string): string[] {
  return body
    .replace('/', ' ')
    .split(/[\s,]+/)
    .filter((t) => t !== '');
}

/** Alpha token → 0–1 (bare 0–1 or a percentage); default opaque. */
function alphaOf(toks: string[], i: number): number {
  if (i >= toks.length) return 1;
  const t = toks[i];
  return t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

/**
 * Parse a CSS/SVG colour into linear-light RGBA. Returns `null` for `none`, and
 * resolves `currentColor` against `current` (defaulting to opaque black).
 */
export function parseColor(input: string, current?: LinearRgba): LinearRgba | null {
  const s = input.trim();
  const lower = s.toLowerCase();
  if (lower === 'none') return null;
  if (lower === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (lower === 'currentcolor') return current ?? { r: 0, g: 0, b: 0, a: 1 };

  if (s[0] === '#') {
    const hex = parseHex(s);
    if (hex) return hex;
    throw new Error(`invalid hex colour "${s}"`);
  }

  const fn = /^([a-z]+)\s*\((.*)\)$/i.exec(s);
  if (fn) {
    const name = fn[1].toLowerCase();
    const toks = tokens(fn[2]);
    if (name === 'rgb' || name === 'rgba') {
      // A percentage channel is 0–1; a bare number is 0–255.
      const chan = (t: string): number => (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t) / 255);
      return linear(chan(toks[0]), chan(toks[1]), chan(toks[2]), alphaOf(toks, 3));
    }
    if (name === 'hsl' || name === 'hsla') {
      const s2 = toks[1].endsWith('%') ? parseFloat(toks[1]) / 100 : parseFloat(toks[1]);
      const l2 = toks[2].endsWith('%') ? parseFloat(toks[2]) / 100 : parseFloat(toks[2]);
      const [r, g, b] = hslToRgb(parseFloat(toks[0]), s2, l2);
      return linear(r, g, b, alphaOf(toks, 3));
    }
    throw new Error(`unsupported colour function ${name}()`);
  }

  if (Object.prototype.hasOwnProperty.call(NAMED, lower)) {
    return fromHexInt(NAMED[lower]);
  }
  throw new Error(`unrecognized colour "${s}"`);
}
