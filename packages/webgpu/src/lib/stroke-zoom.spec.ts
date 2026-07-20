import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  ellipsePath,
  flattenPath,
  pointInPath,
  resolveOverlaps,
  SceneDocument,
  type PathNode,
  type Path,
} from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';
import glyphs from './__fixtures__/serif-glyphs.json';

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}
function pixel(rb: ReadbackResult, x: number, y: number): { r: number; g: number; b: number } {
  const o = y * rb.bytesPerRow + x * 4;
  const [c0, c1, c2] = [rb.data[o], rb.data[o + 1], rb.data[o + 2]];
  return rb.format.startsWith('bgra') ? { r: c2, g: c1, b: c0 } : { r: c0, g: c1, b: c2 };
}

// The 'e' whose crossbar overlaps its body — the glyph that showed a dark stroke
// seam inside the fill on the deployed build.
const ePath = (glyphs as Record<string, Path>)['e'];

describe('stroked glyph renders no interior seam (end-to-end)', () => {
  it('paints only fill deep inside the letter, never the stroke', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'e',
      path: ePath,
      fill: { type: 'solid', color: { r: 0.3, g: 0.55, b: 1, a: 1 } }, // bright blue
      stroke: { paint: { type: 'solid', color: { r: 0.05, g: 0.08, b: 0.17, a: 1 } }, width: 26, join: 'round' },
    });

    const size = 300;
    const zoom = 0.58;
    const pan = { x: 18, y: 25 }; // centres the glyph bbox in view
    const renderer = await WebGpuRenderer.create(makeCanvas(size), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera({ zoom, pan })));
    const rb = await renderer.readback();
    renderer.destroy();

    // Deep-interior glyph points (whole neighbourhood inside), mapped to screen.
    // Every one must read as blue fill; none as the dark stroke.
    const half = 13;
    const ring = half + 8;
    let checked = 0;
    let strokeInFill = 0;
    for (let gy = -8; gy <= 438; gy += 6) {
      for (let gx = 42; gx <= 415; gx += 6) {
        if (!pointInPath(ePath, { x: gx, y: gy }, 'nonzero')) continue;
        let deep = true;
        for (let a = 0; a < 8; a++) {
          const rx = gx + Math.cos((a * Math.PI) / 4) * ring;
          const ry = gy + Math.sin((a * Math.PI) / 4) * ring;
          if (!pointInPath(ePath, { x: rx, y: ry }, 'nonzero')) {
            deep = false;
            break;
          }
        }
        if (!deep) continue;
        const sx = Math.round(pan.x + zoom * gx);
        const sy = Math.round(pan.y + zoom * gy);
        if (sx < 1 || sy < 1 || sx >= size - 1 || sy >= size - 1) continue;
        checked++;
        const p = pixel(rb, sx, sy);
        // dark (stroke or bg) where fill is expected → seam intrusion
        if (!(p.b > 150 && p.g > 80)) strokeInFill++;
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(strokeInFill).toBe(0);
  });

  // The arc-join optimisation skips joins at shallow turns; verify it leaves no
  // gaps in the stroke of a smooth convex curve (a circle is all convex turns).
  it('strokes a circle with a continuous, gap-free band', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'ring',
      path: ellipsePath(0, 0, 60, 60),
      fill: undefined,
      stroke: { paint: { type: 'solid', color: { r: 0.9, g: 0.5, b: 0.2, a: 1 } }, width: 6, join: 'round' },
    });
    const size = 200;
    const zoom = 1.4;
    const pan = { x: 100, y: 100 }; // centre the circle at world origin
    const renderer = await WebGpuRenderer.create(makeCanvas(size), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera({ zoom, pan })));
    const rb = await renderer.readback();
    renderer.destroy();

    // Sample the stroke centreline all the way round; every sample must be lit
    // (the orange stroke), never background — a skipped join would show a gap.
    const R = 60 * zoom;
    let gaps = 0;
    const N = 720;
    for (let k = 0; k < N; k++) {
      const a = (2 * Math.PI * k) / N;
      const sx = Math.round(pan.x + Math.cos(a) * R);
      const sy = Math.round(pan.y + Math.sin(a) * R);
      const p = pixel(rb, sx, sy);
      if (p.r + p.g + p.b < 60) gaps++; // background (unlit) on the centreline
    }
    expect(gaps).toBe(0);
  });

  // The regression the user hit: a thin round stroke on a glyph at high zoom drew
  // dark ink ACROSS the letter and stray blobs. With distance-field stroking the
  // stroke is exactly "within half-width of the centerline", so EVERY stroke
  // pixel must be near the glyph outline — no blob can exist anywhere.
  it('keeps every stroke pixel within half-width of the centerline (no blobs)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const width = 26; // thin relative to the ~1000-unit glyph, like display text
    doc.insert<PathNode>({
      type: 'path',
      name: 'e',
      path: ePath,
      fill: { type: 'solid', color: { r: 0.3, g: 0.55, b: 1, a: 1 } },
      stroke: { paint: { type: 'solid', color: { r: 0.05, g: 0.08, b: 0.17, a: 1 } }, width, join: 'round' },
    });
    const size = 340;
    const zoom = 0.62;
    const pan = { x: 10, y: 20 };
    const renderer = await WebGpuRenderer.create(makeCanvas(size), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera({ zoom, pan })));
    const rb = await renderer.readback();
    renderer.destroy();

    // Screen-space polyline of the stroked centerline (overlap-resolved outline).
    const poly = flattenPath(resolveOverlaps(ePath), 1).map((line) =>
      line.map((pt) => ({ x: pan.x + zoom * pt.x, y: pan.y + zoom * pt.y }))
    );
    const distToCenter = (x: number, y: number): number => {
      let best = Infinity;
      for (const line of poly)
        for (let i = 0; i + 1 < line.length; i++) {
          const a = line[i];
          const b = line[i + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const l2 = dx * dx + dy * dy || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
          best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
        }
      return best;
    };
    const half = (width / 2) * zoom;
    let strokePixels = 0;
    let blobs = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = pixel(rb, x, y);
        const lum = p.r + p.g + p.b;
        if (lum < 20 || p.b > 130) continue; // background or blue fill
        strokePixels++;
        if (distToCenter(x, y) > half + 3) blobs++;
      }
    }
    expect(strokePixels).toBeGreaterThan(200); // the stroke is actually drawn
    expect(blobs).toBe(0); // and never strays off the outline
  });
});
