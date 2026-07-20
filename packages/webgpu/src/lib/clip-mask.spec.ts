import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  rectPath,
  SceneDocument,
  type MaskNode,
  type MaskType,
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

async function render(doc: SceneDocument, size = 64): Promise<ReadbackResult> {
  const renderer = await WebGpuRenderer.create(makeCanvas(size), { colorSpace: 'srgb', dither: false });
  renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
  renderer.setRenderList(buildRenderList(doc, createCamera()));
  const rb = await renderer.readback();
  renderer.destroy();
  return rb;
}

describe('clipping & masks', () => {
  it('clips a filled rect to the left half (geometric clip)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'r',
      path: rectPath(0, 0, 64, 64),
      fill: WHITE,
      clip: { path: rectPath(0, 0, 32, 64) },
    });
    const rb = await render(doc);
    expect(pixel(rb, 16, 32).r).toBeGreaterThan(230); // inside the clip
    expect(Math.max(pixel(rb, 48, 32).r, pixel(rb, 48, 32).g, pixel(rb, 48, 32).b)).toBeLessThan(20); // clipped away
  });

  it('applies a luminance mask (a white shape reveals, empty area hides)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const mask = doc.insert<MaskNode>({ type: 'mask', name: 'm' });
    // Mask content: an opaque white rect over the left half -> luminance 1 there.
    doc.insert<PathNode>({ type: 'path', name: 'mc', path: rectPath(0, 0, 32, 64), fill: WHITE }, { parentId: mask.id });
    doc.insert<PathNode>({
      type: 'path',
      name: 'r',
      path: rectPath(0, 0, 64, 64),
      fill: WHITE,
      mask: { maskId: mask.id, type: 'luminance' },
    });
    const rb = await render(doc);
    expect(pixel(rb, 16, 32).r).toBeGreaterThan(230); // revealed by the white mask
    expect(Math.max(pixel(rb, 48, 32).r, pixel(rb, 48, 32).g, pixel(rb, 48, 32).b)).toBeLessThan(20); // no mask -> hidden
  });

  it('distinguishes alpha from luminance: a black opaque shape masks by alpha, not luminance', async () => {
    const build = (type: MaskType): SceneDocument => {
      const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
      const mask = doc.insert<MaskNode>({ type: 'mask', name: 'm' });
      // Opaque BLACK: luminance 0 (hides under luminance), alpha 1 (reveals under alpha).
      doc.insert<PathNode>(
        { type: 'path', name: 'mc', path: rectPath(0, 0, 64, 64), fill: { type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } } },
        { parentId: mask.id }
      );
      doc.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 64, 64), fill: WHITE, mask: { maskId: mask.id, type } });
      return doc;
    };
    const lum = await render(build('luminance'));
    expect(Math.max(pixel(lum, 32, 32).r, pixel(lum, 32, 32).g, pixel(lum, 32, 32).b)).toBeLessThan(20); // black lum -> hidden
    const alpha = await render(build('alpha'));
    expect(pixel(alpha, 32, 32).r).toBeGreaterThan(230); // opaque alpha -> revealed
  });

  it('soft-masks with a gradient (partial coverage in the middle)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const mask = doc.insert<MaskNode>({ type: 'mask', name: 'm' });
    doc.insert<PathNode>(
      {
        type: 'path',
        name: 'mc',
        path: rectPath(0, 0, 64, 64),
        fill: {
          type: 'linear-gradient',
          start: { x: 0, y: 0 },
          end: { x: 64, y: 0 },
          stops: [
            { offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
            { offset: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
          ],
        },
      },
      { parentId: mask.id }
    );
    doc.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 64, 64), fill: WHITE, mask: { maskId: mask.id } });
    const rb = await render(doc);
    // Left (mask≈black) mostly hidden, right (mask≈white) revealed, and the
    // coverage rises monotonically across the gradient (the soft-mask proof).
    // sRGB encoding of small linear mask values lifts the darks, so the absolute
    // left bound is loose; the ordering is the real assertion.
    expect(pixel(rb, 3, 32).r).toBeLessThan(110);
    expect(pixel(rb, 60, 32).r).toBeGreaterThan(200);
    expect(pixel(rb, 60, 32).r).toBeGreaterThan(pixel(rb, 32, 32).r);
    expect(pixel(rb, 32, 32).r).toBeGreaterThan(pixel(rb, 3, 32).r);
  });
});
