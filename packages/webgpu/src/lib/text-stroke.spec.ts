import { buildRenderList, createCamera, createSequentialIdFactory, flattenPath, pathBounds, SceneDocument, type PathNode, type Path } from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';
import vt from './__fixtures__/vectortype.json';

const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const px = (rb: ReadbackResult, x: number, y: number) => { const o = y * rb.bytesPerRow + x * 4; return [rb.data[o], rb.data[o + 1], rb.data[o + 2]]; };

// The exact "Vector Type" outline produced by layoutTextNode (fontSize 96),
// miter-stroked — the deployed scene. Rendered STROKE-ONLY (so nothing is hidden
// under the fill) and measured against the RAW glyph outline (not the
// overlap-resolved one — which is what a bug would corrupt). A stroke line
// cutting across a letter sits far from every real edge; a correct stroke never
// exceeds the miter reach. This catches the interior-diagonal bug where
// resolveOverlaps, normalized by the whole line, mis-resolved a mid-line glyph.
describe('stroked "Vector Type" stays on the glyph edges', () => {
  it('has no stroke pixel far from the raw outline (no interior diagonal)', async () => {
    const path = vt as Path;
    const b = pathBounds(path)!;
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 't',
      path,
      fill: undefined, // stroke only — nothing hidden under the fill
      stroke: { paint: { type: 'solid', color: { r: 0.2, g: 0.8, b: 0.9, a: 1 } }, width: 2.5, join: 'miter' },
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

    // Reference = the RAW glyph outline (the true shape), in screen space.
    const poly = flattenPath(path, 0.3).map((l) => l.map((p) => ({ x: panx + zoom * p.x, y: pany + zoom * p.y })));
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
    // A miter apex reaches at most miterLimit*half (4 * 1.25 = 5 local units);
    // allow AA + slack. An interior stroke line is far past this.
    const limit = (5 + 3) * zoom;
    let strokePixels = 0;
    let stray = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [r, g, bl] = px(rb, x, y);
      if (r + g + bl < 30) continue; // background
      strokePixels++;
      if (d2c(x, y) > limit) stray++;
    }
    expect(strokePixels).toBeGreaterThan(500);
    // A real interior stroke line is hundreds of pixels; tolerate a few isolated
    // AA pixels at the sharpest miter apexes.
    expect(stray).toBeLessThan(15);
  });
});
