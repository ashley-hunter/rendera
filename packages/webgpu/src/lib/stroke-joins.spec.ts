import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  rectPath,
  SceneDocument,
  type PathNode,
  type StrokeJoin,
} from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';

function makeCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}
function lit(rb: ReadbackResult, x: number, y: number): boolean {
  const o = y * rb.bytesPerRow + x * 4;
  return rb.data[o] + rb.data[o + 1] + rb.data[o + 2] > 40;
}

async function renderRectStroke(join: StrokeJoin): Promise<ReadbackResult> {
  const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
  doc.insert<PathNode>({
    type: 'path',
    name: 'r',
    path: rectPath(16, 16, 32, 32),
    stroke: { paint: { type: 'solid', color: { r: 0.2, g: 0.8, b: 0.9, a: 1 } }, width: 12, join },
  });
  const renderer = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false });
  renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
  renderer.setRenderList(buildRenderList(doc, createCamera()));
  const rb = await renderer.readback();
  renderer.destroy();
  return rb;
}

describe('distance-field stroke joins', () => {
  // The outer corner of a rect stroked width 12 sits at (16,16); the sharp miter
  // apex reaches to ~(10,10). A round join only reaches half (6) from the vertex,
  // so the diagonal corner at (10,10) is bare. This is exactly
  // the fix for serif text looking beaded under round joins.
  it('miter fills the sharp outer corner that round leaves bare', async () => {
    const miter = await renderRectStroke('miter');
    const round = await renderRectStroke('round');
    // Past the round join's reach, but inside the mitred corner.
    expect(lit(miter, 10, 10)).toBe(true);
    expect(lit(round, 10, 10)).toBe(false);
    // The edge mid-run is stroked for both (sanity).
    expect(lit(miter, 32, 16)).toBe(true);
    expect(lit(round, 32, 16)).toBe(true);
    // Interior stays empty for both.
    expect(lit(miter, 32, 32)).toBe(false);
    expect(lit(round, 32, 32)).toBe(false);
  });
});
