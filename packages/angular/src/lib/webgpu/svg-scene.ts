import { importSvg, SceneDocument, createSequentialIdFactory, type LinearRgba } from '@rendera/core';
import type { SceneSource } from './webgpu-scene';

/** sRGB 0–255 to linear-light (for the clear colour only). */
function rgb(r: number, g: number, b: number, a = 1): LinearRgba {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return { r: lin(r), g: lin(g), b: lin(b), a };
}

/**
 * A single self-contained SVG illustration — imported, not hand-built. It leans
 * on every part of the importer: linear + radial gradients (sky, water, sun,
 * hills) resolved in each shape's local space; cubic/quadratic/smooth Bézier
 * curves and an elliptical arc in path data; basic shapes (rect, circle);
 * grouped elements inheriting a stroke; a rotated group of sun rays (transform);
 * and even-odd fill. Because it lowers to the same analytic vector nodes as
 * everything else, it stays razor-sharp at any zoom.
 */
const ART = `
<svg width="480" height="360" viewBox="0 0 480 360">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#241a4d"/>
      <stop offset="0.45" stop-color="#7b4b8a"/>
      <stop offset="0.75" stop-color="#e8825e"/>
      <stop offset="1" stop-color="#ffce7b"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff7d6"/>
      <stop offset="0.55" stop-color="#ffd166"/>
      <stop offset="1" stop-color="#ff8f4d"/>
    </radialGradient>
    <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffc46b"/>
      <stop offset="0.5" stop-color="#c9708a"/>
      <stop offset="1" stop-color="#3d2a63"/>
    </linearGradient>
    <linearGradient id="hillA" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5a2f6e"/>
      <stop offset="1" stop-color="#331a4a"/>
    </linearGradient>
    <linearGradient id="hillB" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a1f52"/>
      <stop offset="1" stop-color="#20123a"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="480" height="360" fill="url(#sky)"/>

  <!-- Sun rays: one triangle, cloned by a rotated group. -->
  <g transform="translate(240 150)" fill="#ffd98a" opacity="0.35">
    <g transform="rotate(0)"><polygon points="0,-130 -10,0 10,0"/></g>
    <g transform="rotate(40)"><polygon points="0,-130 -10,0 10,0"/></g>
    <g transform="rotate(80)"><polygon points="0,-130 -10,0 10,0"/></g>
    <g transform="rotate(160)"><polygon points="0,-130 -10,0 10,0"/></g>
    <g transform="rotate(220)"><polygon points="0,-130 -10,0 10,0"/></g>
    <g transform="rotate(300)"><polygon points="0,-130 -10,0 10,0"/></g>
  </g>

  <circle cx="240" cy="150" r="66" fill="url(#sun)"/>

  <!-- Birds: a group of smooth quadratic strokes sharing the stroke style. -->
  <g stroke="#2a1c48" stroke-width="3" fill="none">
    <path d="M96 84 q 12 -12 24 0 q 12 -12 24 0"/>
    <path d="M330 68 q 10 -10 20 0 q 10 -10 20 0"/>
  </g>

  <!-- Water. -->
  <rect x="0" y="222" width="480" height="138" fill="url(#water)"/>

  <!-- Distant hills (cubic + smooth-cubic), nearer hills (quadratic + smooth). -->
  <path d="M0 222 C 90 188 150 214 240 200 S 400 180 480 210 L 480 240 L 0 240 Z" fill="url(#hillA)"/>
  <path d="M0 240 Q 130 210 260 232 T 480 236 L 480 268 L 0 268 Z" fill="url(#hillB)"/>

  <!-- A little sailboat: an even-odd hull cut-out plus an arc-topped sail. -->
  <g transform="translate(300 250)">
    <path fill="#1c1030" fill-rule="evenodd"
          d="M-34 8 H34 L22 26 H-22 Z M-16 14 H16 L10 20 H-10 Z"/>
    <path fill="#f4e7c9" d="M0 -34 L18 6 H0 Z"/>
    <path fill="#e07a5f" d="M0 -34 L-16 6 H0 Z"/>
  </g>

  <!-- A moon crescent via two overlapping circles (even-odd on one path). -->
  <path fill="#fdf1c0" opacity="0.85"
        d="M96 300 A 22 22 0 1 1 96 256 A 17 17 0 1 0 96 300 Z"/>
</svg>
`;

/** A `SceneSource` that renders an imported SVG illustration. */
export function createSvgScene(): SceneSource {
  const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('svg') });
  importSvg(doc, ART);
  return { document: doc, clearColor: rgb(18, 14, 34) };
}
