import {
  createTransform,
  ellipsePath,
  roundedRectPath,
  SceneDocument,
  vec2,
  type BooleanNode,
  type BooleanOp,
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

/**
 * One boolean result at (x, y): a circle and a rounded square combined by `op`,
 * gradient-filled with a thin stroke — proving the combined outline is a real,
 * exact-curve, strokable path (not just a rendered region).
 */
function cell(doc: SceneDocument, x: number, y: number, op: BooleanOp, fill: Fill): void {
  const node = doc.insert<BooleanNode>({
    type: 'boolean',
    name: op,
    op,
    transform: createTransform({ translation: vec2(x, y) }),
    fill,
    stroke: { paint: { type: 'solid', color: rgb(12, 14, 22) }, width: 2.5, join: 'round' },
  });
  // Two overlapping operands in the cell's local space.
  doc.insert<PathNode>(
    { type: 'path', name: 'circle', path: ellipsePath(78, 96, 60, 60) },
    { parentId: node.id }
  );
  doc.insert<PathNode>(
    { type: 'path', name: 'square', path: roundedRectPath(96, 60, 108, 108, 18) },
    { parentId: node.id }
  );
}

/**
 * A `SceneSource` showcasing geometric boolean operations: union, intersection,
 * difference, and exclusion (XOR) of a circle and a rounded square. Each result
 * is a NEW exact-curve path — filled with a gradient and stroked, and it stays
 * razor-sharp under deep zoom (no flattening).
 */
export function createBooleanScene(): SceneSource {
  const doc = SceneDocument.create({ name: 'Booleans' });
  const gap = 260;

  cell(doc, 20, 20, 'union', {
    type: 'linear-gradient',
    start: vec2(0, 40),
    end: vec2(0, 200),
    stops: [{ offset: 0, color: rgb(255, 214, 120) }, { offset: 1, color: rgb(240, 118, 74) }],
  });
  cell(doc, 20 + gap, 20, 'intersect', {
    type: 'linear-gradient',
    start: vec2(40, 0),
    end: vec2(220, 0),
    stops: [{ offset: 0, color: rgb(120, 220, 255) }, { offset: 1, color: rgb(70, 110, 235) }],
  });
  cell(doc, 20, 20 + gap, 'difference', {
    type: 'radial-gradient',
    start: { center: vec2(120, 120), radius: 6 },
    end: { center: vec2(120, 120), radius: 130 },
    stops: [{ offset: 0, color: rgb(250, 150, 200) }, { offset: 1, color: rgb(190, 50, 120) }],
  });
  cell(doc, 20 + gap, 20 + gap, 'xor', {
    type: 'linear-gradient',
    start: vec2(20, 20),
    end: vec2(210, 210),
    interpolation: 'oklab',
    stops: [{ offset: 0, color: rgb(140, 240, 170) }, { offset: 1, color: rgb(40, 170, 130) }],
  });

  return {
    document: doc,
    clearColor: rgb(15, 16, 22),
  };
}
