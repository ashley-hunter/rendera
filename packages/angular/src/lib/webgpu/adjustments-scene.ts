import {
  createTransform,
  rectPath,
  SceneDocument,
  vec2,
  type Effect,
  type Fill,
  type LinearRgba,
  type PathNode,
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

const CELL = 200;
const GAP = 26;

/** A vivid spectrum sweep — the shared subject every cell adjusts. */
function spectrum(): Fill {
  return {
    type: 'linear-gradient',
    start: vec2(0, 0),
    end: vec2(CELL, CELL),
    stops: [
      { offset: 0.0, color: rgb(255, 64, 64) },
      { offset: 0.2, color: rgb(255, 196, 64) },
      { offset: 0.4, color: rgb(96, 220, 96) },
      { offset: 0.6, color: rgb(64, 208, 224) },
      { offset: 0.8, color: rgb(96, 120, 255) },
      { offset: 1.0, color: rgb(220, 96, 230) },
    ],
  };
}

/**
 * A `SceneSource` showcasing adjustment layers (ADR 0013): the same spectrum
 * subject repeated six times, each with a different non-destructive adjustment —
 * original, brightness, contrast, desaturate, hue shift, and a levels curve. All
 * are parametric and evaluated at render in linear light.
 */
export function createAdjustmentsScene(): SceneSource {
  const doc = SceneDocument.create({ name: 'Adjustments' });

  const cells: Effect[][] = [
    [], // original
    [{ type: 'brightness-contrast', brightness: 0.22, contrast: 0 }],
    [{ type: 'brightness-contrast', brightness: 0, contrast: 0.55 }],
    [{ type: 'hue-saturation', saturation: -1 }],
    [{ type: 'hue-saturation', hue: 140, saturation: 0.2 }],
    [{ type: 'levels', inBlack: 0.15, inWhite: 0.85, gamma: 1.4 }],
  ];

  cells.forEach((effects, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    doc.insert<PathNode>({
      type: 'path',
      name: `cell-${i}`,
      path: rectPath(0, 0, CELL, CELL),
      fill: spectrum(),
      transform: createTransform({ translation: vec2(col * (CELL + GAP), row * (CELL + GAP)) }),
      effects,
    });
  });

  return { document: doc, clearColor: rgb(20, 20, 28) };
}
