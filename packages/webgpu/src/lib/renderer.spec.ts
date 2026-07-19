import { encode8, linearToSrgb } from './color';
import { WebGpuRenderer } from './renderer';

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

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
});
