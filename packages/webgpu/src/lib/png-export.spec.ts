import { buildRenderList, createCamera, createSequentialIdFactory, rectPath, SceneDocument, type PathNode } from '@rendera/core';
import { WebGpuRenderer } from './renderer';

describe('WebGpuRenderer.toPng', () => {
  it('encodes the frame as a valid PNG of the right size', async () => {
    const W = 40;
    const H = 24;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(4, 4, 32, 16), fill: { type: 'solid', color: { r: 0.8, g: 0.1, b: 0.1, a: 1 } } });
    const renderer = await WebGpuRenderer.create(canvas, { colorSpace: 'srgb', dither: false });
    renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setRenderList(buildRenderList(doc, createCamera()));
    const png = await renderer.toPng();
    renderer.destroy();

    // PNG signature.
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // First chunk is IHDR with the canvas dimensions.
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(String.fromCharCode(png[12], png[13], png[14], png[15])).toBe('IHDR');
    expect(dv.getUint32(16)).toBe(W);
    expect(dv.getUint32(20)).toBe(H);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA
    // Ends with an IEND chunk.
    const tail = png.subarray(png.length - 8); // IEND: type(4) + crc(4)
    expect(String.fromCharCode(tail[0], tail[1], tail[2], tail[3])).toBe('IEND');
  });
});
