import { buildRenderList, createCamera, createSequentialIdFactory, flattenPath, pathBounds, resolveOverlaps, SceneDocument, type PathNode, type Path } from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';
import vt from './__fixtures__/vectortype.json';

const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const px = (rb: ReadbackResult, x: number, y: number) => { const o = y * rb.bytesPerRow + x * 4; return [rb.data[o], rb.data[o + 1], rb.data[o + 2]]; };

// The exact "Vector Type" outline produced by layoutTextNode (fontSize 96),
// miter-stroked — the deployed scene. A stroke must stay near the glyph edge;
// a stroke line cutting diagonally through a letter would sit far from the
// centerline. This guards against the interior-diagonal / miter-spike class of
// bug across the whole stroked line.
describe('stroked "Vector Type" has no interior stroke line', () => {
  it('keeps every stroke pixel near the glyph outline', async () => {
    const path = vt as Path;
    const b = pathBounds(path)!;
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 't',
      path,
      fill: { type: 'solid', color: { r: 0.3, g: 0.55, b: 1, a: 1 } },
      stroke: { paint: { type: 'solid', color: { r: 0.05, g: 0.08, b: 0.17, a: 1 } }, width: 2.5, join: 'miter' },
    });
    const W = 620;
    const H = 130;
    const zoom = (W - 12) / (b.maxX - b.minX);
    const panx = 6 - b.minX * zoom;
    const pany = H / 2 - ((b.minY + b.maxY) / 2) * zoom;
    const renderer = await WebGpuRenderer.create(mk(W, H), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera({ zoom, pan: { x: panx, y: pany } })));
    const rb = await renderer.readback();
    renderer.destroy();

    const poly = flattenPath(resolveOverlaps(path), 0.3).map((l) => l.map((p) => ({ x: panx + zoom * p.x, y: pany + zoom * p.y })));
    const d2c = (x: number, y: number): number => {
      let best = 1e9;
      for (const l of poly) for (let i = 0; i + 1 < l.length; i++) {
        const a = l[i], c = l[i + 1];
        const dx = c.x - a.x, dy = c.y - a.y, L = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L));
        best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
      }
      return best;
    };
    // A miter apex reaches at most miterLimit*half (4 * 1.25 = 5 local units)
    // from the outline; anything well past that is an interior stroke line.
    const limit = (5 + 3) * zoom;
    let strokePixels = 0;
    let stray = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [r, g, bl] = px(rb, x, y);
      const lum = r + g + bl;
      if (lum < 20 || (bl > 130 && g > 60)) continue; // background or blue fill
      strokePixels++;
      if (d2c(x, y) > limit) stray++;
    }

    expect(strokePixels).toBeGreaterThan(500);
    // A real interior stroke line would be hundreds of pixels; tolerate a few
    // isolated AA pixels at the sharpest miter apexes.
    expect(stray).toBeLessThan(12);
  });
});
