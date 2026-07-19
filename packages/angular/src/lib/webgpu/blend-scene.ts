import {
  BLEND_MODES,
  createTransform,
  SceneDocument,
  vec2,
  type GroupNode,
  type LayerNode,
  type LinearRgba,
} from '@rendera/core';
import type { SceneSource } from './webgpu-scene';

const WIDTH = 840;
const HEIGHT = 640;

/** Vivid backdrop bands, so every blend mode has colour to interact with. */
const BANDS: LinearRgba[] = [
  { r: 0.9, g: 0.12, b: 0.12, a: 1 },
  { r: 0.1, g: 0.7, b: 0.25, a: 1 },
  { r: 0.15, g: 0.35, b: 0.92, a: 1 },
  { r: 0.96, g: 0.85, b: 0.1, a: 1 },
];

/**
 * A `SceneSource` showcasing the compositor: four vivid backdrop bands with a
 * 4x4 grid of squares over them, one per W3C blend mode (row-major, matching
 * `BLEND_MODES`), plus a half-opacity isolated group in the corner. Every mode
 * composites in linear light against the coloured backdrop.
 */
export function createBlendScene(): SceneSource {
  const doc = SceneDocument.create({ name: 'Blend modes' });

  BANDS.forEach((color, i) => {
    doc.insert<LayerNode>({
      type: 'layer',
      name: `band ${i}`,
      size: vec2(WIDTH / BANDS.length, HEIGHT),
      transform: createTransform({ translation: vec2((i * WIDTH) / BANDS.length, 0) }),
      fill: { type: 'solid', color },
    });
  });

  // A 4x4 grid: one square per blend mode, filled a light neutral grey so the
  // modes read clearly (multiply darkens, screen lightens, etc.).
  const cols = 4;
  const colW = WIDTH / cols;
  const rowH = HEIGHT / 4;
  const cell = Math.min(colW, rowH) - 34;
  BLEND_MODES.forEach((mode, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * colW + (colW - cell) / 2;
    const y = row * rowH + (rowH - cell) / 2;
    doc.insert<LayerNode>({
      type: 'layer',
      name: mode,
      size: vec2(cell, cell),
      transform: createTransform({ translation: vec2(x, y) }),
      fill: { type: 'solid', color: { r: 0.72, g: 0.72, b: 0.72, a: 1 } },
      blendMode: mode,
    });
  });

  // A half-opacity isolated group (two overlapping squares fade as one unit).
  const group = doc.insert<GroupNode>({ type: 'group', name: 'faded group', opacity: 0.5 });
  doc.insert<LayerNode>(
    {
      type: 'layer',
      name: 'a',
      size: vec2(120, 120),
      transform: createTransform({ translation: vec2(40, HEIGHT - 150) }),
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
    },
    { parentId: group.id }
  );
  doc.insert<LayerNode>(
    {
      type: 'layer',
      name: 'b',
      size: vec2(120, 120),
      transform: createTransform({ translation: vec2(110, HEIGHT - 90) }),
      fill: { type: 'solid', color: { r: 0.1, g: 0.1, b: 0.12, a: 1 } },
    },
    { parentId: group.id }
  );

  return {
    document: doc,
    clearColor: { r: 0.06, g: 0.06, b: 0.07, a: 1 },
  };
}
