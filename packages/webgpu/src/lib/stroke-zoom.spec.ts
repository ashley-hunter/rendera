import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  pointInPath,
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
});
