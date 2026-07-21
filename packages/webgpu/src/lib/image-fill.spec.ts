import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  rectPath,
  SceneDocument,
  type ImagePaint,
  type PathNode,
  type SpreadMode,
} from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';

const mk = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};
const px = (rb: ReadbackResult, x: number, y: number): [number, number, number] => {
  const o = y * rb.bytesPerRow + x * 4;
  const [c0, c1, c2] = [rb.data[o], rb.data[o + 1], rb.data[o + 2]];
  return rb.format.startsWith('bgra') ? [c2, c1, c0] : [c0, c1, c2];
};

// A 2x2 image: TL red, TR green (top row), BL blue, BR yellow (bottom row).
async function quadImage(): Promise<ImageBitmap> {
  const d = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]);
  return createImageBitmap(new ImageData(d, 2, 2));
}

async function render(paint: ImagePaint, W: number, H: number): Promise<ReadbackResult> {
  const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
  doc.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, W, H), fill: paint });
  const renderer = await WebGpuRenderer.create(mk(W, H), { colorSpace: 'srgb', dither: false });
  renderer.registerImage('quad', await quadImage());
  renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
  renderer.setRenderList(buildRenderList(doc, createCamera()));
  const rb = await renderer.readback();
  renderer.destroy();
  return rb;
}

const dominant = (p: [number, number, number]): string => {
  const [r, g, b] = p;
  const red = r > 150, grn = g > 150, blu = b > 150;
  if (red && grn && !blu) return 'yellow';
  if (red && !grn && !blu) return 'red';
  if (!red && grn && !blu) return 'green';
  if (!red && !grn && blu) return 'blue';
  return `other(${r},${g},${b})`;
};

// unit image square [0,1]² → local rect [0,size]².
const fit = (size: number, spread?: SpreadMode): ImagePaint => ({
  type: 'image',
  assetId: 'quad',
  transform: { a: size, b: 0, c: 0, d: size, e: 0, f: 0 },
  spread,
});

describe('image & pattern fills', () => {
  it('maps a placed image across the shape (pad)', async () => {
    const rb = await render(fit(64, 'pad'), 64, 64);
    // The four quadrants of the rect show the four image texels.
    expect(dominant(px(rb, 16, 16))).toBe('red'); // TL
    expect(dominant(px(rb, 48, 16))).toBe('green'); // TR
    expect(dominant(px(rb, 16, 48))).toBe('blue'); // BL
    expect(dominant(px(rb, 48, 48))).toBe('yellow'); // BR
  });

  it('tiles a pattern (repeat) — a 32px image fills a 64px rect as 2x2', async () => {
    const rb = await render(fit(32, 'repeat'), 64, 64);
    // Top row of the image (uv.y≈0.25) at y=8; bottom row (uv.y≈0.75) at y=24.
    expect(dominant(px(rb, 8, 8))).toBe('red');
    expect(dominant(px(rb, 24, 8))).toBe('green');
    expect(dominant(px(rb, 8, 24))).toBe('blue');
    expect(dominant(px(rb, 24, 24))).toBe('yellow');
    // The next tile over (x += 32) and down (y += 32) repeat the same texels.
    expect(dominant(px(rb, 40, 8))).toBe('red'); // x wraps 1.25 → 0.25
    expect(dominant(px(rb, 8, 40))).toBe('red'); // y wraps 1.25 → 0.25
    expect(dominant(px(rb, 56, 56))).toBe('yellow'); // both wrap → (0.75, 0.75)
  });

  it('clamps outside the image with pad (image smaller than the shape)', async () => {
    // Place the image in the top-left 32px; pad clamps the rest to the edge texels.
    const rb = await render(fit(32, 'pad'), 64, 64);
    expect(dominant(px(rb, 8, 8))).toBe('red'); // inside the image
    // Far right stays the right column (green/yellow), never wraps back to red.
    expect(dominant(px(rb, 60, 8))).toBe('green'); // clamped TR
    expect(dominant(px(rb, 60, 60))).toBe('yellow'); // clamped BR
  });
});
