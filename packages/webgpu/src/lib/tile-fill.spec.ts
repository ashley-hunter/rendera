import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  rectPath,
  SceneDocument,
  type PathNode,
} from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';

const S = 200;
const mk = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  return c;
};
const lum = (rb: ReadbackResult, x: number, y: number): number => {
  const o = y * rb.bytesPerRow + x * 4;
  return rb.data[o] + rb.data[o + 1] + rb.data[o + 2];
};

// A shape large enough that its interior, its hole, and the area around it each
// span many 16px tiles — so the fill is decided by the UNIFORM-tile fast path
// (constant winding computed at the tile centre), not the per-pixel band loop.
// The even-odd hole is the exact case that broke a naive per-tile backdrop: its
// empty centre is a uniform tile whose winding (2, even) must read as outside.
describe('uniform-tile fill overlay', () => {
  it('fills a big even-odd donut correctly through the tile fast path', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'donut',
      path: { subpaths: [rectPath(20, 20, 160, 160).subpaths[0], rectPath(80, 80, 40, 40).subpaths[0]] },
      fillRule: 'evenodd',
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
    });
    const renderer = await WebGpuRenderer.create(mk(), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback();
    renderer.destroy();

    // Deep interior between the squares (a uniform inside tile, ~20px from any
    // edge): solid white.
    expect(lum(rb, 40, 100)).toBeGreaterThan(720);
    expect(lum(rb, 100, 40)).toBeGreaterThan(720);
    // Hole centre (uniform tile, winding 2 → even → outside): empty.
    expect(lum(rb, 100, 100)).toBeLessThan(30);
    // Well outside the shape (uniform outside tile): empty.
    expect(lum(rb, 6, 6)).toBeLessThan(30);
    // The outer contour (a boundary tile runs the exact band loop): filled just
    // inside the left edge, empty just outside it.
    expect(lum(rb, 24, 100)).toBeGreaterThan(720);
    expect(lum(rb, 15, 100)).toBeLessThan(30);
  });

  it('fills a big nonzero rectangle solid in its interior tiles', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'r',
      path: rectPath(24, 24, 152, 152),
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
    });
    const renderer = await WebGpuRenderer.create(mk(), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback();
    renderer.destroy();

    // Many interior sample points, all far from the edges → uniform tiles.
    for (const [x, y] of [[40, 40], [100, 100], [150, 60], [60, 150], [150, 150]]) {
      expect(lum(rb, x, y)).toBeGreaterThan(720);
    }
    expect(lum(rb, 4, 4)).toBeLessThan(30); // outside
  });
});
