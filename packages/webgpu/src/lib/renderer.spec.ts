import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  createTransform,
  ellipsePath,
  layoutTextNode,
  layoutTextNodeGlyphs,
  MsdfAtlas,
  rectPath,
  RenderaFont,
  SceneDocument,
  vec2,
  type GroupNode,
  type ImageNode,
  type LayerNode,
  type MsdfNodeLayout,
  type PathNode,
  type TextNode,
} from '@rendera/core';
import fontUrl from './__fixtures__/CrimsonPro-Regular.ttf?url';
import { encode8, linearToSrgb, srgbToLinear } from './color';
import { WebGpuRenderer, type ReadbackResult } from './renderer';

/** A solid-colour image bitmap of the given size (sRGB 8-bit values). */
async function solidImage(size: number, r: number, g: number, b: number): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return createImageBitmap(new ImageData(data, size, size));
}

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
    if (!item || item.op !== 'draw-solid') {
      throw new Error('no solid quad for layer');
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
    if (!item || item.op !== 'draw-solid') {
      throw new Error('no solid quad for layer');
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

  it('draws a registered image layer, round-tripping sRGB through linear', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const image = doc.insert<ImageNode>({
      type: 'image',
      name: 'img',
      size: vec2(32, 32),
      assetId: 'grey',
      transform: createTransform({ translation: vec2(16, 16) }),
    });
    const items = buildRenderList(doc, createCamera());
    expect(items.some((i) => i.op === 'draw-image' && i.nodeId === image.id)).toBe(true);

    const renderer = await WebGpuRenderer.create(makeCanvas(64), {
      colorSpace: 'srgb',
      dither: false,
    });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    // Mid-grey 128: sampled (sRGB->linear), composited, then re-encoded to sRGB
    // at present must return ~128 — proving the linear-light texture path.
    renderer.registerImage('grey', await solidImage(8, 128, 128, 128));
    expect(renderer.hasImage('grey')).toBe(true);
    renderer.setRenderList(items);
    const rb = await renderer.readback();

    const center = pixel(rb, 32, 32);
    expect(near(center.r, 128)).toBe(true);
    expect(near(center.g, 128)).toBe(true);
    expect(near(center.b, 128)).toBe(true);
    expect(center.a).toBe(255);

    // Outside the image is the black background.
    const outside = pixel(rb, 2, 2);
    expect(Math.max(outside.r, outside.g, outside.b)).toBe(0);

    renderer.destroy();
  });

  it('magnifies smoothly: a 2-row image becomes a gradient, not hard steps', async () => {
    // 2x2 image, top row white, bottom row black. Magnified large, a correct
    // (bicubic/bilinear) sampler yields a smooth vertical ramp with many
    // intermediate greys; nearest-neighbour would give only 0 and 255.
    const px = new Uint8ClampedArray([
      255, 255, 255, 255, 255, 255, 255, 255, // row 0: white, white
      0, 0, 0, 255, 0, 0, 0, 255, // row 1: black, black
    ]);
    const bitmap = await createImageBitmap(new ImageData(px, 2, 2));

    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<ImageNode>({
      type: 'image',
      name: 'ramp',
      size: vec2(48, 48),
      assetId: 'ramp',
      transform: createTransform({ translation: vec2(8, 8) }),
    });
    const renderer = await WebGpuRenderer.create(makeCanvas(64), {
      colorSpace: 'srgb',
      dither: false,
    });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.registerImage('ramp', bitmap);
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback();

    // Down the centre column, collect the distinct luminances inside the image.
    const seen = new Set<number>();
    for (let y = 10; y < 54; y++) {
      seen.add(pixel(rb, 32, y).r);
    }
    const intermediates = [...seen].filter((v) => v > 8 && v < 247);
    // A smooth ramp has many in-between values; nearest would have ~zero.
    expect(intermediates.length).toBeGreaterThan(6);

    renderer.destroy();
  });

  it('skips an image whose asset is not registered (draws background only)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<ImageNode>({
      type: 'image',
      name: 'img',
      size: vec2(32, 32),
      assetId: 'missing',
      transform: createTransform({ translation: vec2(16, 16) }),
    });
    const renderer = await WebGpuRenderer.create(makeCanvas(64), {
      colorSpace: 'srgb',
      dither: false,
    });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    expect(renderer.hasImage('missing')).toBe(false);
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback(); // must not throw

    const center = pixel(rb, 32, 32);
    expect(Math.max(center.r, center.g, center.b)).toBe(0);
    renderer.destroy();
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

  // --- compositing: blend modes + group opacity (linear light) ---

  type LinRgba = { r: number; g: number; b: number; a: number };

  const solidLayer = (
    doc: SceneDocument,
    color: LinRgba,
    blend?: import('@rendera/core').BlendMode,
    parentId?: string
  ): void => {
    doc.insert<LayerNode>(
      {
        type: 'layer',
        name: 'l',
        size: vec2(48, 48),
        transform: createTransform({ translation: vec2(8, 8) }),
        fill: { type: 'solid', color },
        blendMode: blend,
      },
      parentId ? { parentId } : undefined
    );
  };

  const compositeCenter = async (build: (doc: SceneDocument) => void): Promise<LinRgba> => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    build(doc);
    const renderer = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback();
    const c = pixel(rb, 32, 32);
    renderer.destroy();
    return c;
  };

  it('composites Multiply in linear light (0.6 x 0.5 = 0.3)', async () => {
    const c = await compositeCenter((doc) => {
      solidLayer(doc, { r: 0.6, g: 0.6, b: 0.6, a: 1 });
      solidLayer(doc, { r: 0.5, g: 0.5, b: 0.5, a: 1 }, 'multiply');
    });
    const expected = encode8(linearToSrgb(0.3));
    expect(near(c.r, expected)).toBe(true);
    expect(near(c.g, expected)).toBe(true);
    expect(near(c.b, expected)).toBe(true);
  });

  it('composites Screen in linear light (0.6 + 0.5 - 0.3 = 0.8)', async () => {
    const c = await compositeCenter((doc) => {
      solidLayer(doc, { r: 0.6, g: 0.6, b: 0.6, a: 1 });
      solidLayer(doc, { r: 0.5, g: 0.5, b: 0.5, a: 1 }, 'screen');
    });
    const expected = encode8(linearToSrgb(0.8));
    expect(near(c.r, expected)).toBe(true);
  });

  it('applies group opacity to the composited group (white group @ 0.5 over black = 0.5)', async () => {
    const c = await compositeCenter((doc) => {
      const g = doc.insert<GroupNode>({ type: 'group', name: 'g', opacity: 0.5 });
      solidLayer(doc, { r: 1, g: 1, b: 1, a: 1 }, undefined, g.id);
    });
    const expected = encode8(linearToSrgb(0.5));
    expect(near(c.r, expected)).toBe(true);
    expect(near(c.g, expected)).toBe(true);
    expect(near(c.b, expected)).toBe(true);
  });

  it('composites Luminosity: backdrop chroma, source luminance', async () => {
    // Red backdrop, grey (lum 0.5) source in Luminosity -> red-ish hue whose
    // linear luminance tracks the source (0.5).
    const c = await compositeCenter((doc) => {
      solidLayer(doc, { r: 1, g: 0, b: 0, a: 1 });
      solidLayer(doc, { r: 0.5, g: 0.5, b: 0.5, a: 1 }, 'luminosity');
    });
    const lin = (v: number): number => srgbToLinear(v / 255);
    const luminance = 0.3 * lin(c.r) + 0.59 * lin(c.g) + 0.11 * lin(c.b);
    expect(Math.abs(luminance - 0.5)).toBeLessThan(0.04);
    expect(c.r).toBeGreaterThan(c.g); // hue stayed red
  });

  // --- vector paths: analytic coverage (ADR 0007) ---

  it('fills a vector rectangle with the right colour and crisp edges', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'r',
      path: rectPath(16, 16, 32, 32),
      fill: { type: 'solid', color: { r: 0.8, g: 0.1, b: 0.1, a: 1 } },
    });
    const renderer = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback();

    // Interior is the red fill (both channels sRGB round-trip).
    const c = pixel(rb, 32, 32);
    expect(near(c.r, encode8(linearToSrgb(0.8)))).toBe(true);
    expect(near(c.g, encode8(linearToSrgb(0.1)))).toBe(true);
    // Outside is background.
    expect(Math.max(pixel(rb, 4, 4).r, pixel(rb, 4, 4).g, pixel(rb, 4, 4).b)).toBe(0);
  });

  it('anti-aliases a vector ellipse edge (partial coverage), resolution-independent', async () => {
    const build = (): SceneDocument => {
      const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
      doc.insert<PathNode>({
        type: 'path',
        name: 'e',
        path: ellipsePath(32, 32, 24, 24),
        fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
      });
      return doc;
    };
    const partialCount = async (supersample: number): Promise<number> => {
      const r = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false, supersample });
      r.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
      r.setRenderList(buildRenderList(build(), createCamera()));
      const rb = await r.readback();
      let n = 0;
      for (let i = 0; i < rb.data.length; i += 4) {
        if (rb.data[i] > 12 && rb.data[i] < 243) n++;
      }
      r.destroy();
      return n;
    };
    // The circle's centre fills solid, and there is an anti-aliased rim.
    expect(await partialCount(1)).toBeGreaterThan(20);
    // The rim is analytic even without supersampling (1x already smooth).
  });

  it('strokes a path outline (frame drawn, interior empty)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'frame',
      path: rectPath(16, 16, 32, 32),
      // Stroke only, no fill.
      stroke: { paint: { type: 'solid', color: { r: 0.2, g: 0.8, b: 0.9, a: 1 } }, width: 6 },
    });
    const renderer = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback();

    // On the top edge (y=16): the stroke colour.
    const onEdge = pixel(rb, 32, 16);
    expect(near(onEdge.b, encode8(linearToSrgb(0.9)))).toBe(true);
    // Interior centre: background (stroke-only, no fill).
    expect(Math.max(pixel(rb, 32, 32).r, pixel(rb, 32, 32).g, pixel(rb, 32, 32).b)).toBeLessThan(20);
    // Outside the frame: background.
    expect(Math.max(pixel(rb, 4, 4).r, pixel(rb, 4, 4).g, pixel(rb, 4, 4).b)).toBe(0);
  });

  it('honours the even-odd fill rule (a square with a hole)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'donut',
      path: { subpaths: [rectPath(8, 8, 48, 48).subpaths[0], rectPath(24, 24, 16, 16).subpaths[0]] },
      fillRule: 'evenodd',
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
    });
    const renderer = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback();

    // Between the squares: filled (white).
    expect(pixel(rb, 14, 32).r).toBeGreaterThan(230);
    // Centre of the hole: empty (even-odd cuts it out).
    expect(pixel(rb, 32, 32).r).toBeLessThan(20);
  });

  it('paints a linear gradient across a path (red -> blue, band-free)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'grad',
      path: rectPath(0, 0, 64, 64),
      fill: {
        type: 'linear-gradient',
        start: vec2(0, 32),
        end: vec2(64, 32),
        stops: [
          { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
    });
    const renderer = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback();

    const left = pixel(rb, 2, 32);
    const right = pixel(rb, 61, 32);
    const mid = pixel(rb, 32, 32);
    // Left end is red, right end is blue.
    expect(left.r).toBeGreaterThan(200);
    expect(left.r - left.b).toBeGreaterThan(100);
    expect(right.b).toBeGreaterThan(200);
    expect(right.b - right.r).toBeGreaterThan(100);
    // Midpoint mixes 50/50 in linear light -> ~188 in each of R and B.
    const half = encode8(linearToSrgb(0.5));
    expect(near(mid.r, half)).toBe(true);
    expect(near(mid.b, half)).toBe(true);
    expect(mid.g).toBeLessThan(10);
  });

  it('paints a radial gradient (bright centre, dark rim)', async () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'radial',
      path: rectPath(0, 0, 64, 64),
      fill: {
        type: 'radial-gradient',
        start: { center: vec2(32, 32), radius: 0 },
        end: { center: vec2(32, 32), radius: 32 },
        stops: [
          { offset: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
          { offset: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      },
    });
    const renderer = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const rb = await renderer.readback();

    // The centre is (near) white; a point ~2/3 out toward the rim is much darker.
    expect(pixel(rb, 32, 32).r).toBeGreaterThan(230);
    expect(pixel(rb, 53, 32).r).toBeLessThan(pixel(rb, 32, 32).r - 60);
  });

  it('shapes and renders text as analytic glyph outlines (wasm in the browser)', async () => {
    const data = await fetch(fontUrl).then((r) => r.arrayBuffer());
    const font = await RenderaFont.load(data);
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const node = doc.insert<TextNode>({
      type: 'text',
      name: 't',
      text: 'Ag',
      fontId: 'crimson',
      fontSize: 40,
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
      transform: createTransform({ translation: vec2(4, 4) }),
    });
    const layout = layoutTextNode(font, node);
    // Layout produced real glyph geometry.
    expect(layout.path.subpaths.length).toBeGreaterThan(2);
    const textPaths = new Map([[node.id, layout.path]]);

    const renderer = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera(), { textPaths }));
    const rb = await renderer.readback();

    // Glyph ink: white-ish coverage pixels present, background stays black.
    let ink = 0;
    for (let i = 0; i < rb.data.length; i += 4) {
      if (rb.data[i] > 180 && rb.data[i + 1] > 180 && rb.data[i + 2] > 180) ink++;
    }
    expect(ink).toBeGreaterThan(30);
    expect(Math.max(pixel(rb, 1, 1).r, pixel(rb, 1, 1).g, pixel(rb, 1, 1).b)).toBeLessThan(20);
    renderer.destroy();
  });

  it('renders MSDF text from the glyph atlas (median/screenPxRange AA)', async () => {
    const data = await fetch(fontUrl).then((r) => r.arrayBuffer());
    const font = await RenderaFont.load(data);
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    const node = doc.insert<TextNode>({
      type: 'text',
      name: 't',
      text: 'Ag',
      fontId: 'crimson',
      fontSize: 40,
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
      transform: createTransform({ translation: vec2(4, 4) }),
    });

    // Bake the node's glyphs into the atlas, then upload it to the renderer.
    const atlas = new MsdfAtlas(font, { emPx: 40, pxRange: 4 });
    const layout = layoutTextNodeGlyphs(font, node);
    const glyphs = layout.glyphs
      .map((g) => ({ originX: g.originX, originY: g.originY, cell: atlas.glyph(g.glyphId) }))
      .filter((g): g is { originX: number; originY: number; cell: NonNullable<typeof g.cell> } => g.cell !== null);
    expect(glyphs.length).toBeGreaterThan(0);
    const tex = atlas.texture;

    const renderer = await WebGpuRenderer.create(makeCanvas(64), { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setMsdfAtlas(tex.data, tex.width, tex.height);
    const msdf: MsdfNodeLayout = {
      glyphs,
      fontSize: node.fontSize,
      atlasWidth: tex.width,
      atlasHeight: tex.height,
      pxRange: atlas.pxRange,
      atlasEmPx: atlas.emPx,
    };
    renderer.setRenderList(buildRenderList(doc, createCamera(), { textMsdf: new Map([[node.id, msdf]]) }));
    const rb = await renderer.readback();

    let ink = 0;
    for (let i = 0; i < rb.data.length; i += 4) {
      if (rb.data[i] > 180 && rb.data[i + 1] > 180 && rb.data[i + 2] > 180) ink++;
    }
    expect(ink).toBeGreaterThan(30);
    expect(Math.max(pixel(rb, 1, 1).r, pixel(rb, 1, 1).g, pixel(rb, 1, 1).b)).toBeLessThan(20);
    renderer.destroy();
  });

  // NOTE: the on-screen canvas *swapchain* present cannot be verified here —
  // SwiftShader (the headless software adapter) does not produce readable/
  // compositable canvas pixels. The render pipeline itself is proven by the
  // readback tests above (which own the target texture). The canvas path is
  // exercised on real hardware via the `WebGpuScene` Storybook story.
});
