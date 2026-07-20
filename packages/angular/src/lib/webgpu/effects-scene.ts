import {
  createTransform,
  ellipsePath,
  polygonPath,
  roundedRectPath,
  SceneDocument,
  vec2,
  type Effect,
  type Fill,
  type LinearRgba,
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
const GAP = 70;

function at(x: number, y: number) {
  return createTransform({ translation: vec2(x, y) });
}

function star(cx: number, cy: number, outer: number, inner: number): ReturnType<typeof polygonPath> {
  const pts: Vec2[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    pts.push(vec2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return polygonPath(pts);
}

function diagonal(from: LinearRgba, to: LinearRgba): Fill {
  return {
    type: 'linear-gradient',
    start: vec2(30, 30),
    end: vec2(CELL - 30, CELL - 30),
    interpolation: 'oklab',
    stops: [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ],
  };
}

/**
 * A `SceneSource` showcasing non-destructive effects (ADR 0012):
 *  - a floating card with a soft DROP SHADOW,
 *  - a star with a coloured OUTER GLOW (neon),
 *  - a frosted circle under a Gaussian BLUR,
 *  - a card with a glow AND a shadow (a chained effect list).
 * Effects are parametric and evaluated at render — zoom in and they re-resolve,
 * staying smooth at any scale.
 */
export function createEffectsScene(): SceneSource {
  const doc = SceneDocument.create({ name: 'Effects' });
  const c2 = CELL + GAP;
  const r2 = CELL + GAP;

  // A: floating card + soft drop shadow.
  const shadow: Effect = { type: 'drop-shadow', dx: 0, dy: 14, radius: 20, color: rgb(0, 0, 0, 0.75) };
  doc.insert<PathNode>({
    type: 'path',
    name: 'card',
    path: roundedRectPath(30, 30, CELL - 60, CELL - 60, 28),
    fill: diagonal(rgb(255, 138, 128), rgb(255, 214, 120)),
    transform: at(0, 0),
    effects: [shadow],
  });

  // B: neon star + outer glow.
  doc.insert<PathNode>({
    type: 'path',
    name: 'neon',
    path: star(CELL / 2, CELL / 2, 92, 40),
    fill: { type: 'solid', color: rgb(255, 90, 200) },
    transform: at(c2, 0),
    effects: [{ type: 'outer-glow', radius: 26, color: rgb(255, 60, 210) }],
  });

  // C: frosted circle under a blur.
  doc.insert<PathNode>({
    type: 'path',
    name: 'frosted',
    path: ellipsePath(CELL / 2, CELL / 2, 80, 80),
    fill: diagonal(rgb(120, 220, 255), rgb(90, 110, 240)),
    transform: at(0, r2),
    effects: [{ type: 'blur', radius: 14 }],
  });

  // D: chained — a card with a glow then a drop shadow.
  doc.insert<PathNode>({
    type: 'path',
    name: 'chained',
    path: roundedRectPath(40, 40, CELL - 80, CELL - 80, 24),
    fill: diagonal(rgb(120, 255, 200), rgb(46, 213, 160)),
    transform: at(c2, r2),
    effects: [
      { type: 'outer-glow', radius: 22, color: rgb(70, 255, 190) },
      { type: 'drop-shadow', dx: 0, dy: 16, radius: 22, color: rgb(0, 0, 0, 0.7) },
    ],
  });

  return { document: doc, clearColor: rgb(30, 32, 44) };
}
