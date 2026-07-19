import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  createTransform,
  SceneDocument,
  vec2,
  type GroupNode,
  type LayerNode,
} from '@rendera/core';
import { encode8, linearToSrgb } from './color';
import { WebGpuRenderer, type ReadbackResult } from './renderer';

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function pixel(
  rb: ReadbackResult,
  x: number,
  y: number
): { r: number; g: number; b: number; a: number } {
  const o = y * rb.bytesPerRow + x * 4;
  const [c0, c1, c2, c3] = [rb.data[o], rb.data[o + 1], rb.data[o + 2], rb.data[o + 3]];
  return rb.format.startsWith('bgra')
    ? { r: c2, g: c1, b: c0, a: c3 }
    : { r: c0, g: c1, b: c2, a: c3 };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2;

describe('WebGpuRenderer colour pipeline', () => {
  it('acquires a WebGPU device (SwiftShader in headless CI)', async () => {
    expect('gpu' in navigator).toBe(true);
    const renderer = await WebGpuRenderer.create(makeCanvas(4), { dither: false });
    expect(renderer.format).toBeTruthy();
    renderer.destroy();
  });

  it('encodes a linear clear colour to the correct sRGB output', async () => {
    const renderer = await WebGpuRenderer.create(makeCanvas(4), {
      colorSpace: 'srgb',
      dither: false,
    });
    renderer.setClearColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 });

    const { data, format } = await renderer.readback();
    const expected = encode8(linearToSrgb(0.5)); // ~188

    // Grey: R=G=B, so channel order (bgra/rgba) does not matter for the colour.
    expect(Math.abs(data[0] - expected)).toBeLessThanOrEqual(1);
    expect(Math.abs(data[1] - expected)).toBeLessThanOrEqual(1);
    expect(Math.abs(data[2] - expected)).toBeLessThanOrEqual(1);
    expect(data[3]).toBe(255); // opaque
    expect(format).toMatch(/8unorm/);

    renderer.destroy();
  });

  it('does not encode linear black/white incorrectly', async () => {
    const renderer = await WebGpuRenderer.create(makeCanvas(4), { dither: false });

    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    expect((await renderer.readback()).data[0]).toBe(0);

    renderer.setClearColor({ r: 1, g: 1, b: 1, a: 1 });
    expect((await renderer.readback()).data[0]).toBe(255);

    renderer.destroy();
  });

  it('draws a render-list quad at the right place and colour', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const layer = doc.insert<LayerNode>({
      type: 'layer',
      name: 'l',
      size: vec2(32, 32),
      transform: createTransform({ translation: vec2(16, 16) }),
    });
    const items = buildRenderList(doc, createCamera());
    const item = items.find((i) => i.nodeId === layer.id);
    if (!item) {
      throw new Error('no quad for layer');
    }

    const renderer = await WebGpuRenderer.create(makeCanvas(64), {
      colorSpace: 'srgb',
      dither: false,
    });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 }); // black background
    renderer.setRenderList(items);
    const rb = await renderer.readback();

    // The quad covers screen px [16,16]..[48,48].
    const center = pixel(rb, 32, 32);
    expect(near(center.r, encode8(linearToSrgb(item.color.r)))).toBe(true);
    expect(near(center.g, encode8(linearToSrgb(item.color.g)))).toBe(true);
    expect(near(center.b, encode8(linearToSrgb(item.color.b)))).toBe(true);
    expect(center.a).toBe(255);

    // A corner well outside the quad is the (black) background.
    const outside = pixel(rb, 2, 2);
    expect(outside.r).toBe(0);
    expect(outside.g).toBe(0);
    expect(outside.b).toBe(0);

    renderer.destroy();
  });

  it('blue-noise dither splits a between-levels grey across both levels, unbiased', async () => {
    // Linear 0.5 encodes to ~187.53/255 — between two 8-bit levels. Undithered,
    // every pixel rounds to one flat value; blue-noise dither spreads pixels
    // across both adjacent levels so the spatial mean tracks the true value.
    const channel0 = (rb: ReadbackResult): number[] => {
      const v: number[] = [];
      for (let i = 0; i < rb.data.length; i += 4) {
        v.push(rb.data[i]);
      }
      return v;
    };
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const expected = 255 * linearToSrgb(0.5);

    const flatR = await WebGpuRenderer.create(makeCanvas(64), {
      colorSpace: 'srgb',
      dither: false,
    });
    flatR.setClearColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
    const flat = channel0(await flatR.readback());
    flatR.destroy();

    const ditheredR = await WebGpuRenderer.create(makeCanvas(64), {
      colorSpace: 'srgb',
      dither: true,
    });
    ditheredR.setClearColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
    const dithered = channel0(await ditheredR.readback());
    ditheredR.destroy();

    // Undithered: one flat level everywhere.
    expect(new Set(flat).size).toBe(1);

    // Dithered: exactly the two adjacent levels, and unbiased about the truth.
    const levels = [...new Set(dithered)].sort((a, b) => a - b);
    expect(levels.length).toBe(2);
    expect(levels[1] - levels[0]).toBe(1);
    expect(Math.abs(mean(dithered) - expected)).toBeLessThan(0.5);
    // The dithered mean is a better estimate of the true value than the flat one.
    expect(Math.abs(mean(dithered) - expected)).toBeLessThan(Math.abs(flat[0] - expected));
  });

  it('supersamples: a rotated edge gets partial-coverage pixels that 1x lacks', async () => {
    // A rotated quad on a black background. With no supersampling every pixel is
    // fully inside or outside the quad (binary edge). With 2x supersampling the
    // edge pixels get fractional coverage -> intermediate luminance. Dither is
    // off so the only source of in-between values is the box-filtered edge.
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const layer = doc.insert<LayerNode>({
      type: 'layer',
      name: 'r',
      size: vec2(28, 28),
      transform: createTransform({ translation: vec2(32, 32), rotation: 0.4 }),
    });
    const items = buildRenderList(doc, createCamera());
    const item = items.find((i) => i.nodeId === layer.id);
    if (!item) {
      throw new Error('no quad for layer');
    }
    const quadMax = encode8(
      linearToSrgb(Math.max(item.color.r, item.color.g, item.color.b))
    );

    // Count edge pixels whose brightest channel is strictly between the
    // background (0) and the solid quad colour.
    const countPartial = (rb: ReadbackResult): number => {
      let n = 0;
      for (let i = 0; i < rb.data.length; i += 4) {
        const m = Math.max(rb.data[i], rb.data[i + 1], rb.data[i + 2]);
        if (m > 4 && m < quadMax - 4) {
          n++;
        }
      }
      return n;
    };

    const aliased = await WebGpuRenderer.create(makeCanvas(64), {
      colorSpace: 'srgb',
      dither: false,
      supersample: 1,
    });
    aliased.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    aliased.setRenderList(items);
    const partial1 = countPartial(await aliased.readback());
    expect(aliased.scale).toBe(1);
    aliased.destroy();

    const smooth = await WebGpuRenderer.create(makeCanvas(64), {
      colorSpace: 'srgb',
      dither: false,
      supersample: 2,
    });
    smooth.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    smooth.setRenderList(items);
    const partial2 = countPartial(await smooth.readback());
    expect(smooth.scale).toBe(2);
    smooth.destroy();

    // 1x has (near) no in-between pixels; 2x has a smooth, partially-covered edge.
    expect(partial1).toBeLessThanOrEqual(2);
    expect(partial2).toBeGreaterThan(partial1);
    expect(partial2).toBeGreaterThan(10);
  });

  it('renders the sample scene at story scale (non-empty)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const g = doc.insert<GroupNode>({
      type: 'group',
      name: 'g',
      transform: createTransform({ translation: vec2(80, 70) }),
    });
    doc.insert<LayerNode>({ type: 'layer', name: 'A', size: vec2(120, 80) }, { parentId: g.id });
    doc.insert<LayerNode>(
      { type: 'layer', name: 'C', size: vec2(110, 60), transform: createTransform({ translation: vec2(280, 40) }) }
    );
    const items = buildRenderList(doc, createCamera({ pan: vec2(20, 20) }));

    const canvas = document.createElement('canvas');
    canvas.width = 866;
    canvas.height = 439;
    const renderer = await WebGpuRenderer.create(canvas, { colorSpace: 'srgb', dither: true });
    renderer.setClearColor({ r: 0.02, g: 0.02, b: 0.03, a: 1 });
    renderer.setRenderList(items);
    const rb = await renderer.readback();

    let colored = 0;
    for (let i = 0; i < rb.data.length; i += 4) {
      if (Math.max(rb.data[i], rb.data[i + 1], rb.data[i + 2]) > 40) {
        colored++;
      }
    }
    expect(items.length).toBe(2);
    expect(colored).toBeGreaterThan(0);

    renderer.destroy();
  });

  // NOTE: the on-screen canvas *swapchain* present cannot be verified here —
  // SwiftShader (the headless software adapter) does not produce readable/
  // compositable canvas pixels. The render pipeline itself is proven by the
  // readback tests above (which own the target texture). The canvas path is
  // exercised on real hardware via the `WebGpuScene` Storybook story.
});
