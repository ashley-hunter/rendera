import {
  ellipsePath,
  polygonPath,
  roundedRectPath,
  SceneDocument,
  vec2,
  type ImagePaint,
  type PathNode,
  type Vec2,
} from '@rendera/core';
import type { SceneSource } from './webgpu-scene';

/** An asymmetric 128px motif tile (so reflect reads differently from repeat):
 *  a tinted ground, a big off-centre disc, a corner wedge, and a bold "R". */
function drawTile(size = 128): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#0e1729';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.arc(size * 0.62, size * 0.4, size * 0.28, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#22d3ee';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size * 0.42, 0);
  ctx.lineTo(0, size * 0.42);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f8fafc';
  ctx.font = `800 ${Math.round(size * 0.42)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('R', size * 0.34, size * 0.72);
  return canvas;
}

/** unit image square [0,1]² → a `w`×`h` box at (x,y) in local space. */
const box = (x: number, y: number, w: number, h: number): ImagePaint['transform'] => ({ a: w, b: 0, c: 0, d: h, e: x, f: y });

/** A 5-point star centred at (cx,cy). */
function star(cx: number, cy: number, outer: number, inner: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(vec2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return pts;
}

/**
 * A `SceneSource` showcasing the image/pattern paint (the fourth paint kind): the
 * same tile used as a single placed image (`pad`), a tiled `repeat` pattern, a
 * mirror-tiled `reflect` pattern, and a pattern clipped to a star with a stroke.
 * All ride the analytic vector fill, so they stay crisp at any zoom and the
 * minified tiles mip-filter cleanly.
 */
export function createPatternScene(): SceneSource {
  const assetId = 'motif';
  const doc = SceneDocument.create({ name: 'Pattern fills' });
  const add = (path: PathNode['path'], paint: ImagePaint, stroke?: PathNode['stroke']): void => {
    doc.insert<PathNode>({ type: 'path', name: 'p', path, fill: paint, stroke });
  };

  // Row of 260×260 cards at y=40.
  add(roundedRectPath(40, 40, 260, 260, 22), { type: 'image', assetId, transform: box(40, 40, 260, 260), spread: 'pad' });
  add(roundedRectPath(330, 40, 260, 260, 22), { type: 'image', assetId, transform: box(330, 40, 70, 70), spread: 'repeat' });
  add(roundedRectPath(620, 40, 260, 260, 22), { type: 'image', assetId, transform: box(620, 40, 70, 70), spread: 'reflect' });

  // A star filled by the repeating pattern (the pattern clips to the shape),
  // with a thick round-joined stroke.
  add(
    polygonPath(star(1050, 170, 150, 62)),
    { type: 'image', assetId, transform: box(900, 40, 64, 64), spread: 'repeat' },
    { paint: { type: 'solid', color: { r: 0.02, g: 0.09, b: 0.2, a: 1 } }, width: 8, join: 'round' }
  );

  // A pattern-filled ellipse below, to show it on a curved boundary.
  add(ellipsePath(300, 430, 230, 90), { type: 'image', assetId, transform: box(140, 360, 60, 60), spread: 'repeat' });

  return {
    document: doc,
    clearColor: { r: 0.96, g: 0.96, b: 0.98, a: 1 },
    async setup(renderer) {
      renderer.registerImage(assetId, await createImageBitmap(drawTile()));
    },
  };
}
