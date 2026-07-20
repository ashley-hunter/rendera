import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  rectPath,
  SceneDocument,
  type Effect,
  type LinearRgba,
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

async function renderRect(color: LinearRgba, effects: Effect[], size = 32): Promise<ReadbackResult> {
  const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
  doc.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, size, size), fill: { type: 'solid', color }, effects });
  const renderer = await WebGpuRenderer.create(makeCanvas(size), { colorSpace: 'srgb', dither: false });
  renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
  renderer.setRenderList(buildRenderList(doc, createCamera()));
  const rb = await renderer.readback();
  renderer.destroy();
  return rb;
}

const GRAY: LinearRgba = { r: 0.3, g: 0.3, b: 0.3, a: 1 };
const RED: LinearRgba = { r: 1, g: 0, b: 0, a: 1 };
const mid = (rb: ReadbackResult) => pixel(rb, 16, 16);

describe('adjustment layers', () => {
  it('brightness lifts the whole layer', async () => {
    const base = mid(await renderRect(GRAY, []));
    const up = mid(await renderRect(GRAY, [{ type: 'brightness-contrast', brightness: 0.3, contrast: 0 }]));
    expect(up.r).toBeGreaterThan(base.r + 20);
  });

  it('contrast pushes a bright value brighter, a dark value darker', async () => {
    const brightBase = mid(await renderRect({ r: 0.7, g: 0.7, b: 0.7, a: 1 }, []));
    const bright = mid(await renderRect({ r: 0.7, g: 0.7, b: 0.7, a: 1 }, [{ type: 'brightness-contrast', brightness: 0, contrast: 0.6 }]));
    expect(bright.r).toBeGreaterThan(brightBase.r);
    const darkBase = mid(await renderRect({ r: 0.2, g: 0.2, b: 0.2, a: 1 }, []));
    const dark = mid(await renderRect({ r: 0.2, g: 0.2, b: 0.2, a: 1 }, [{ type: 'brightness-contrast', brightness: 0, contrast: 0.6 }]));
    expect(dark.r).toBeLessThan(darkBase.r);
  });

  it('saturation -1 greys a colour out (r ≈ g ≈ b)', async () => {
    const c = mid(await renderRect(RED, [{ type: 'hue-saturation', saturation: -1 }]));
    expect(Math.abs(c.r - c.g)).toBeLessThan(8);
    expect(Math.abs(c.r - c.b)).toBeLessThan(8);
    expect(c.r).toBeGreaterThan(80); // not black — luminance preserved
  });

  it('hue rotation moves red toward green', async () => {
    const c = mid(await renderRect(RED, [{ type: 'hue-saturation', hue: 120 }]));
    expect(c.g).toBeGreaterThan(c.r + 20);
  });

  it('levels gamma brightens the mid-tones', async () => {
    const base = mid(await renderRect({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, []));
    const up = mid(await renderRect({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, [{ type: 'levels', gamma: 2 }]));
    expect(up.r).toBeGreaterThan(base.r + 10);
  });

  it('levels can crush the input black point (mid-grey → black)', async () => {
    const c = mid(await renderRect({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, [{ type: 'levels', inBlack: 0.5 }]));
    expect(Math.max(c.r, c.g, c.b)).toBeLessThan(20);
  });
});
