import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  createTransform,
  rectPath,
  SceneDocument,
  vec2,
  type Effect,
  type PathNode,
} from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';

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
const WHITE = { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } as const;

async function renderRect(x: number, y: number, w: number, h: number, effects: Effect[], size = 64): Promise<ReadbackResult> {
  const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
  doc.insert<PathNode>({
    type: 'path',
    name: 'r',
    path: rectPath(0, 0, w, h),
    fill: WHITE,
    transform: createTransform({ translation: vec2(x, y) }),
    effects,
  });
  const renderer = await WebGpuRenderer.create(makeCanvas(size), { colorSpace: 'srgb', dither: false });
  renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
  renderer.setRenderList(buildRenderList(doc, createCamera()));
  const rb = await renderer.readback();
  renderer.destroy();
  return rb;
}

describe('filters & effects', () => {
  it('gaussian blur softens edges and bleeds beyond the shape', async () => {
    const sharp = await renderRect(20, 20, 24, 24, []);
    const blurred = await renderRect(20, 20, 24, 24, [{ type: 'blur', radius: 10 }]);
    // Original left edge at x=20: outside it (x=12) is background when sharp...
    expect(Math.max(...Object.values(pixel(sharp, 12, 32)))).toBeLessThan(10);
    // ...but the blur bleeds coverage out there.
    expect(pixel(blurred, 12, 32).r).toBeGreaterThan(20);
    // Far outside stays background; the centre stays bright.
    expect(Math.max(...Object.values(pixel(blurred, 2, 32)))).toBeLessThan(12);
    expect(pixel(blurred, 32, 32).r).toBeGreaterThan(120);
  });

  it('drop shadow casts a tinted, offset silhouette behind the shape', async () => {
    const rb = await renderRect(20, 20, 24, 24, [
      { type: 'drop-shadow', dx: 12, dy: 12, radius: 4, color: { r: 1, g: 0, b: 0, a: 1 } },
    ]);
    // The shape covers 20..44; the shadow is offset to ~32..56.
    const shadow = pixel(rb, 52, 52); // in the shadow, outside the white shape
    expect(shadow.r).toBeGreaterThan(40);
    expect(shadow.r).toBeGreaterThan(shadow.g + 20);
    expect(shadow.r).toBeGreaterThan(shadow.b + 20);
    // Opposite corner (up-left of the shape): no shadow there.
    expect(Math.max(...Object.values(pixel(rb, 12, 12)))).toBeLessThan(12);
    // The shape itself is still white on top of its shadow.
    expect(pixel(rb, 30, 30).g).toBeGreaterThan(180);
  });

  it('outer glow surrounds the shape with a tinted halo', async () => {
    const rb = await renderRect(22, 22, 20, 20, [{ type: 'outer-glow', radius: 9, color: { r: 0, g: 0.8, b: 1, a: 1 } }]);
    // Just outside the shape (shape covers 22..42): a cyan halo.
    const halo = pixel(rb, 16, 32);
    expect(halo.b).toBeGreaterThan(12);
    expect(halo.b).toBeGreaterThan(halo.r + 8);
    expect(halo.g).toBeGreaterThan(halo.r + 3);
    // Symmetric on the other side too (glow has no offset).
    expect(pixel(rb, 48, 32).b).toBeGreaterThan(12);
    // Far from the shape: background.
    expect(Math.max(...Object.values(pixel(rb, 2, 2)))).toBeLessThan(12);
  });
});
