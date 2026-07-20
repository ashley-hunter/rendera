import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  importSvg,
  SceneDocument,
} from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function pixel(rb: ReadbackResult, x: number, y: number): { r: number; g: number; b: number } {
  const o = y * rb.bytesPerRow + x * 4;
  const [c0, c1, c2] = [rb.data[o], rb.data[o + 1], rb.data[o + 2]];
  return rb.format.startsWith('bgra') ? { r: c2, g: c1, b: c0 } : { r: c0, g: c1, b: c2 };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 3;

async function renderSvg(svg: string, size = 64): Promise<ReadbackResult> {
  const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
  importSvg(doc, svg);
  const renderer = await WebGpuRenderer.create(makeCanvas(size, size), { colorSpace: 'srgb', dither: false });
  renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
  renderer.setRenderList(buildRenderList(doc, createCamera()));
  const rb = await renderer.readback();
  renderer.destroy();
  return rb;
}

describe('SVG import → analytic render (end to end)', () => {
  it('renders two coloured rects at the right places', async () => {
    const rb = await renderSvg(
      '<svg width="64" height="64">' +
        '<rect x="0" y="0" width="32" height="64" fill="#ff0000"/>' +
        '<rect x="32" y="0" width="32" height="64" fill="#0000ff"/>' +
        '</svg>'
    );
    // Left half red, right half blue (sRGB round-trip of full-strength channels).
    const red = pixel(rb, 12, 32);
    expect(near(red.r, 255)).toBe(true);
    expect(near(red.b, 0)).toBe(true);
    const blue = pixel(rb, 52, 32);
    expect(near(blue.b, 255)).toBe(true);
    expect(near(blue.r, 0)).toBe(true);
  });

  it('maps a viewBox onto the viewport (2x) and fills a circle', async () => {
    // viewBox 0 0 32 32 into a 64 viewport doubles coordinates: a circle at
    // (16,16) r8 in user space renders centred at (32,32) r16 device px.
    const rb = await renderSvg(
      '<svg width="64" height="64" viewBox="0 0 32 32"><circle cx="16" cy="16" r="8" fill="#00ff00"/></svg>'
    );
    const centre = pixel(rb, 32, 32);
    expect(near(centre.g, 255)).toBe(true);
    // A point just outside the scaled radius (device r=16) is background.
    const outside = pixel(rb, 32, 6);
    expect(Math.max(outside.r, outside.g, outside.b)).toBeLessThan(20);
  });

  it('renders a path with a linear gradient fill (objectBoundingBox)', async () => {
    const rb = await renderSvg(
      '<svg width="64" height="64">' +
        '<defs><linearGradient id="g">' +
        '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>' +
        '</linearGradient></defs>' +
        '<path d="M0 0 H64 V64 H0 Z" fill="url(#g)"/></svg>'
    );
    // Red at the left edge, blue at the right, blended across.
    const left = pixel(rb, 2, 32);
    const right = pixel(rb, 61, 32);
    expect(left.r).toBeGreaterThan(left.b);
    expect(right.b).toBeGreaterThan(right.r);
  });

  it('honours evenodd fill-rule from the presentation attribute (square with hole)', async () => {
    const rb = await renderSvg(
      '<svg width="64" height="64">' +
        '<path fill-rule="evenodd" fill="#ffffff" d="M8 8 H56 V56 H8 Z M24 24 H40 V40 H24 Z"/></svg>'
    );
    // Between the squares: filled. Centre of the inner square: cut out.
    expect(pixel(rb, 12, 32).r).toBeGreaterThan(230);
    expect(pixel(rb, 32, 32).r).toBeLessThan(20);
  });
});
