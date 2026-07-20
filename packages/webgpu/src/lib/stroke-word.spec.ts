import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  resolveOverlaps,
  SceneDocument,
  transformPath,
  type PathNode,
  type Path,
} from '@rendera/core';
import { fromTranslation } from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';
import glyphs from './__fixtures__/serif-glyphs.json';

function makeCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}
function pixel(rb: ReadbackResult, x: number, y: number): number[] {
  const o = y * rb.bytesPerRow + x * 4;
  return [rb.data[o], rb.data[o + 1], rb.data[o + 2]];
}

// Merge several glyphs into ONE path, EM-SCALED (glyph ~96 units) as a fontSize
// 96 text node does — the small-coordinate regime where resolveOverlaps' fixed
// tolerances bite.
const EM = 96 / 1024;
function word(): Path {
  const g = glyphs as Record<string, Path>;
  const subpaths: Path['subpaths'] = [];
  let x = 0;
  for (const ch of ['V', 'e', 'a', 'o']) {
    const gp = transformPath(g[ch], fromTranslation({ x, y: 0 }));
    for (const sp of gp.subpaths) {
      subpaths.push({
        start: { x: sp.start.x * EM, y: sp.start.y * EM },
        closed: sp.closed,
        segments: sp.segments.map((s) =>
          s.type === 'quad'
            ? { type: 'quad', control: { x: s.control.x * EM, y: s.control.y * EM }, to: { x: s.to.x * EM, y: s.to.y * EM } }
            : s.type === 'cubic'
              ? { type: 'cubic', c1: { x: s.c1.x * EM, y: s.c1.y * EM }, c2: { x: s.c2.x * EM, y: s.c2.y * EM }, to: { x: s.to.x * EM, y: s.to.y * EM } }
              : { type: 'line', to: { x: s.to.x * EM, y: s.to.y * EM } }
        ),
      });
    }
    x += 620;
  }
  return { subpaths };
}

describe('stroked em-scaled multi-glyph path (whole text line)', () => {
  it('resolves overlaps cleanly and strokes only the edges (no interior mess)', async () => {
    const w = word();
    // The whole-line, em-scaled path must resolve to a handful of contours
    // (V=1, e=2, a=2, o=2 = 7), NOT shatter into dozens (the deployed bug).
    const resolved = resolveOverlaps(w);
    expect(resolved.subpaths.length).toBeLessThanOrEqual(10);
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'word',
      path: w,
      fill: { type: 'solid', color: { r: 0.3, g: 0.55, b: 1, a: 1 } },
      stroke: { paint: { type: 'solid', color: { r: 0.05, g: 0.08, b: 0.17, a: 1 } }, width: 2.5, join: 'round' },
    });
    const size = 100;
    // Frame the 'e' (second glyph): em-scaled center ≈ (848*EM, 215*EM).
    const cx = 848 * EM;
    const cy = 215 * EM;
    const zoom = 100 / 45;
    const renderer = await WebGpuRenderer.create(makeCanvas(size), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera({ zoom, pan: { x: 50 - cx * zoom, y: 50 - cy * zoom } })));
    const rb = await renderer.readback();
    renderer.destroy();

    // Sanity: the 'e' actually rendered — both blue fill and dark stroke present,
    // and a solid blue core exists (a shattered outline would have riddled the
    // fill with stroke instead). The core scale-invariance test proves the fix
    // rigorously; this is the end-to-end guard.
    let blue = 0;
    let stroke = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b] = pixel(rb, x, y);
        const lum = r + g + b;
        if (b > 130 && g > 60) blue++;
        else if (lum > 20 && lum < 130) stroke++;
      }
    }
    expect(blue).toBeGreaterThan(400); // a solid blue glyph body
    expect(stroke).toBeGreaterThan(50); // with a stroke drawn
  });
});
