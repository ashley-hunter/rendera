import {
  createTransform,
  ellipsePath,
  polygonPath,
  roundedRectPath,
  SceneDocument,
  vec2,
  type LinearRgba,
  type PathNode,
} from '@rendera/core';
import type { SceneSource } from './webgpu-scene';

/** sRGB 0–255 (+ optional alpha 0–1) to a linear-light colour. */
function rgb(r: number, g: number, b: number, a = 1): LinearRgba {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return { r: lin(r), g: lin(g), b: lin(b), a };
}

/** A five-pointed star polygon centred at (cx, cy). */
function star(cx: number, cy: number, outer: number, inner: number): ReturnType<typeof polygonPath> {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? outer : inner;
    const ang = (Math.PI * i) / 5 - Math.PI / 2;
    pts.push(vec2(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr));
  }
  return polygonPath(pts);
}

/**
 * A `SceneSource` showcasing gradient paints (linear / radial / conic), all
 * evaluated analytically in the path shader so they stay band-free and
 * resolution-independent at any zoom. The tiles demonstrate multi-stop ramps,
 * the two-circle radial (focal highlight → glossy sphere), a conic colour
 * wheel, `repeat` spread, OKLab vs linear-light interpolation, and a gradient
 * stroke. Zoom in: no banding, no faceting.
 */
export function createGradientScene(): SceneSource {
  const doc = SceneDocument.create({ name: 'Gradients' });

  // Backdrop: a full-frame diagonal sunset, interpolated in OKLab for an even
  // hue sweep with no muddy midpoint.
  doc.insert<PathNode>({
    type: 'path',
    name: 'backdrop',
    path: roundedRectPath(20, 20, 660, 460, 24),
    fill: {
      type: 'linear-gradient',
      start: vec2(20, 20),
      end: vec2(680, 480),
      interpolation: 'oklab',
      stops: [
        { offset: 0, color: rgb(24, 26, 54) },
        { offset: 0.5, color: rgb(158, 44, 96) },
        { offset: 0.82, color: rgb(240, 118, 74) },
        { offset: 1, color: rgb(250, 206, 120) },
      ],
    },
  });

  // Glossy sphere: a radial gradient whose start circle is offset toward the
  // upper-left, giving a specular highlight (the two-circle focal model).
  doc.insert<PathNode>({
    type: 'path',
    name: 'sphere',
    path: ellipsePath(150, 150, 92, 92),
    fill: {
      type: 'radial-gradient',
      start: { center: vec2(118, 118), radius: 6 },
      end: { center: vec2(150, 150), radius: 100 },
      stops: [
        { offset: 0, color: rgb(255, 255, 255) },
        { offset: 0.25, color: rgb(120, 210, 255) },
        { offset: 1, color: rgb(18, 52, 120) },
      ],
    },
  });

  // Conic colour wheel — a full hue sweep around the centre.
  doc.insert<PathNode>({
    type: 'path',
    name: 'wheel',
    path: ellipsePath(420, 150, 90, 90),
    fill: {
      type: 'conic-gradient',
      center: vec2(420, 150),
      angle: -Math.PI / 2,
      interpolation: 'oklab',
      stops: [
        { offset: 0, color: rgb(255, 64, 64) },
        { offset: 0.166, color: rgb(255, 224, 48) },
        { offset: 0.333, color: rgb(72, 224, 72) },
        { offset: 0.5, color: rgb(48, 216, 216) },
        { offset: 0.666, color: rgb(72, 96, 255) },
        { offset: 0.833, color: rgb(216, 72, 224) },
        { offset: 1, color: rgb(255, 64, 64) },
      ],
    },
  });

  // Repeating linear stripes — the same 0..1 ramp tiled across the width.
  doc.insert<PathNode>({
    type: 'path',
    name: 'stripes',
    path: roundedRectPath(560, 300, 340, 150, 18),
    transform: createTransform({ translation: vec2(-300, 0) }),
    fill: {
      type: 'linear-gradient',
      start: vec2(560, 300),
      end: vec2(590, 330),
      spread: 'repeat',
      stops: [
        { offset: 0, color: rgb(20, 24, 40) },
        { offset: 0.5, color: rgb(20, 24, 40) },
        { offset: 0.5, color: rgb(120, 230, 200) },
        { offset: 1, color: rgb(120, 230, 200) },
      ],
    },
  });

  // A star with a gradient fill and a contrasting gradient stroke — proving a
  // single shape carries independent gradient paint on fill and stroke.
  doc.insert<PathNode>({
    type: 'path',
    name: 'star',
    path: star(560, 150, 78, 32),
    fill: {
      type: 'linear-gradient',
      start: vec2(560, 72),
      end: vec2(560, 228),
      stops: [
        { offset: 0, color: rgb(255, 236, 140) },
        { offset: 1, color: rgb(240, 140, 40) },
      ],
    },
    stroke: {
      paint: {
        type: 'linear-gradient',
        start: vec2(482, 150),
        end: vec2(638, 150),
        stops: [
          { offset: 0, color: rgb(120, 40, 180) },
          { offset: 1, color: rgb(220, 60, 120) },
        ],
      },
      width: 6,
      join: 'miter',
    },
  });

  // A wide pill contrasting the two interpolation spaces on the same red→blue
  // ramp: OKLab (top) sweeps through violet; linear-light (bottom) dips dark.
  doc.insert<PathNode>({
    type: 'path',
    name: 'oklab-ramp',
    path: roundedRectPath(80, 360, 420, 42, 21),
    fill: {
      type: 'linear-gradient',
      start: vec2(80, 360),
      end: vec2(500, 360),
      interpolation: 'oklab',
      stops: [
        { offset: 0, color: rgb(230, 40, 40) },
        { offset: 1, color: rgb(40, 60, 230) },
      ],
    },
  });
  doc.insert<PathNode>({
    type: 'path',
    name: 'linear-ramp',
    path: roundedRectPath(80, 412, 420, 42, 21),
    fill: {
      type: 'linear-gradient',
      start: vec2(80, 412),
      end: vec2(500, 412),
      stops: [
        { offset: 0, color: rgb(230, 40, 40) },
        { offset: 1, color: rgb(40, 60, 230) },
      ],
    },
  });

  return {
    document: doc,
    clearColor: rgb(14, 15, 20),
  };
}
