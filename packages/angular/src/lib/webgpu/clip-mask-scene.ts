import {
  createTransform,
  ellipsePath,
  polygonPath,
  rectPath,
  roundedRectPath,
  SceneDocument,
  vec2,
  type ClipPath,
  type Fill,
  type GroupNode,
  type LinearRgba,
  type MaskNode,
  type PathNode,
  type Vec2,
} from '@rendera/core';
import type { SceneSource } from './webgpu-scene';

/** sRGB 0–255 to linear-light. */
function rgb(r: number, g: number, b: number, a = 1): LinearRgba {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return { r: lin(r), g: lin(g), b: lin(b), a };
}

const CELL = 220;
const GAP = 40;

/** A five-pointed star centred at (cx, cy). */
function starPath(cx: number, cy: number, outer: number, inner: number): ReturnType<typeof polygonPath> {
  const pts: Vec2[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    pts.push(vec2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return polygonPath(pts);
}

/** A vivid linear gradient across a cell (for the content that gets clipped/masked). */
function rainbow(): Fill {
  return {
    type: 'linear-gradient',
    start: vec2(0, 0),
    end: vec2(CELL, CELL),
    interpolation: 'oklab',
    stops: [
      { offset: 0, color: rgb(255, 94, 91) },
      { offset: 0.5, color: rgb(255, 205, 96) },
      { offset: 1, color: rgb(72, 219, 251) },
    ],
  };
}

function at(x: number, y: number) {
  return createTransform({ translation: vec2(x, y) });
}

/**
 * A `SceneSource` showcasing clipping and masks (ADR 0011):
 *  - a gradient CLIPPED to a star (geometric, antialiased),
 *  - a gradient softened by a radial LUMINANCE mask (a vignette fading to clear),
 *  - a gradient revealed through an ALPHA mask (diagonal bars),
 *  - a group of overflowing circles CLIPPED to a rounded rectangle.
 * Everything stays razor-sharp and re-editable at any zoom.
 */
export function createClipMaskScene(): SceneSource {
  const doc = SceneDocument.create({ name: 'Clip & Mask' });
  const col2 = CELL + GAP;
  const row2 = CELL + GAP;

  // --- A: gradient clipped to a star -----------------------------------------
  const starClip: ClipPath = { path: starPath(CELL / 2, CELL / 2, 100, 42) };
  doc.insert<PathNode>({
    type: 'path',
    name: 'clip-star',
    path: rectPath(0, 0, CELL, CELL),
    fill: rainbow(),
    transform: at(0, 0),
    clip: starClip,
  });

  // --- B: gradient with a radial luminance mask (soft vignette) ---------------
  const maskB = doc.insert<MaskNode>({ type: 'mask', name: 'vignette' });
  doc.insert<PathNode>(
    {
      type: 'path',
      name: 'vignette-src',
      path: rectPath(0, 0, CELL, CELL),
      fill: {
        type: 'radial-gradient',
        start: { center: vec2(CELL / 2, CELL / 2), radius: 0 },
        end: { center: vec2(CELL / 2, CELL / 2), radius: CELL / 2 },
        stops: [
          { offset: 0, color: rgb(255, 255, 255) },
          { offset: 0.7, color: rgb(255, 255, 255) },
          { offset: 1, color: rgb(0, 0, 0) },
        ],
      },
    },
    { parentId: maskB.id }
  );
  doc.insert<PathNode>({
    type: 'path',
    name: 'mask-vignette',
    path: rectPath(0, 0, CELL, CELL),
    fill: rainbow(),
    transform: at(col2, 0),
    mask: { maskId: maskB.id, type: 'luminance' },
  });

  // --- C: gradient revealed through an alpha mask (diagonal bars) --------------
  const maskC = doc.insert<MaskNode>({ type: 'mask', name: 'bars' });
  for (let i = -1; i < 7; i++) {
    doc.insert<PathNode>(
      {
        type: 'path',
        name: 'bar',
        path: polygonPath([
          vec2(i * 34, 0),
          vec2(i * 34 + 18, 0),
          vec2(i * 34 + 18 + CELL, CELL),
          vec2(i * 34 + CELL, CELL),
        ]),
        fill: { type: 'solid', color: rgb(255, 255, 255) },
      },
      { parentId: maskC.id }
    );
  }
  doc.insert<PathNode>({
    type: 'path',
    name: 'mask-bars',
    path: rectPath(0, 0, CELL, CELL),
    fill: rainbow(),
    transform: at(0, row2),
    mask: { maskId: maskC.id, type: 'alpha' },
  });

  // --- D: a group of overflowing circles clipped to a rounded rect ------------
  const group = doc.insert<GroupNode>({
    type: 'group',
    name: 'clip-group',
    transform: at(col2, row2),
    clip: { path: roundedRectPath(12, 12, CELL - 24, CELL - 24, 44) },
  });
  const dots: [number, number, number, LinearRgba][] = [
    [40, 60, 70, rgb(255, 107, 129)],
    [170, 80, 80, rgb(72, 219, 251)],
    [90, 180, 90, rgb(255, 205, 96)],
    [200, 210, 60, rgb(46, 213, 115)],
  ];
  for (const [cx, cy, r, color] of dots) {
    doc.insert<PathNode>(
      { type: 'path', name: 'dot', path: ellipsePath(cx, cy, r, r), fill: { type: 'solid', color } },
      { parentId: group.id }
    );
  }

  return { document: doc, clearColor: rgb(16, 16, 24) };
}
