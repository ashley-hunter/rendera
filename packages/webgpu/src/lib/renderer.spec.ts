import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  createTransform,
  SceneDocument,
  vec2,
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
});
