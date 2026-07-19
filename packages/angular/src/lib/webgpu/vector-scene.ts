import {
  createTransform,
  ellipsePath,
  polygonPath,
  roundedRectPath,
  SceneDocument,
  vec2,
  type PathNode,
  type Vec2,
} from '@rendera/core';
import type { SceneSource } from './webgpu-scene';

/** An n-pointed star polygon centred at (cx,cy). */
function starPoints(cx: number, cy: number, outer: number, inner: number, points: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / points - Math.PI / 2;
    pts.push(vec2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return pts;
}

/**
 * A `SceneSource` of vector shapes — rounded rects, an ellipse, a star, and an
 * even-odd ring — filled analytically (ADR 0007). Zoom in as far as you like:
 * every edge re-rasterizes razor-sharp, with no faceting or pixelation.
 */
export function createVectorScene(): SceneSource {
  const doc = SceneDocument.create({ name: 'Vectors' });

  doc.insert<PathNode>({
    type: 'path',
    name: 'card',
    path: roundedRectPath(20, 20, 500, 340, 28),
    fill: { type: 'solid', color: { r: 0.13, g: 0.15, b: 0.19, a: 1 } },
  });

  doc.insert<PathNode>({
    type: 'path',
    name: 'circle',
    path: ellipsePath(140, 140, 70, 70),
    fill: { type: 'solid', color: { r: 0.92, g: 0.28, b: 0.3, a: 1 } },
  });

  doc.insert<PathNode>({
    type: 'path',
    name: 'rounded',
    path: roundedRectPath(-55, -55, 110, 110, 26),
    transform: createTransform({ translation: vec2(330, 130), rotation: 0.35 }),
    fill: { type: 'solid', color: { r: 0.25, g: 0.55, b: 0.95, a: 1 } },
  });

  doc.insert<PathNode>({
    type: 'path',
    name: 'star',
    path: polygonPath(starPoints(160, 270, 68, 28, 5)),
    fill: { type: 'solid', color: { r: 0.98, g: 0.78, b: 0.2, a: 1 } },
  });

  // Even-odd ring (outer ellipse with an inner ellipse hole).
  doc.insert<PathNode>({
    type: 'path',
    name: 'ring',
    path: {
      subpaths: [
        ellipsePath(360, 270, 68, 68).subpaths[0],
        ellipsePath(360, 270, 36, 36).subpaths[0],
      ],
    },
    fillRule: 'evenodd',
    fill: { type: 'solid', color: { r: 0.5, g: 0.85, b: 0.45, a: 1 } },
  });

  return {
    document: doc,
    clearColor: { r: 0.06, g: 0.06, b: 0.07, a: 1 },
  };
}
