import { encodePng } from './png';

/** Minimal PNG reader for the test: verifies the encoder end-to-end without a
 *  browser. Reads IHDR, inflates the stored-DEFLATE IDAT, strips filter bytes. */
function decode(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: number[] = [];
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset).getUint32(4);
      expect(data[8]).toBe(8); // bit depth
      expect(data[9]).toBe(6); // RGBA
    } else if (type === 'IDAT') {
      for (const b of data) idat.push(b);
    }
    o += 12 + len;
  }
  // Inflate the zlib stored blocks: skip the 2-byte zlib header, read each
  // stored block (BFINAL/BTYPE byte + LEN + NLEN + LEN literal bytes).
  const z = new Uint8Array(idat);
  let p = 2;
  const raw: number[] = [];
  for (;;) {
    const final = z[p] & 1;
    p += 1;
    const blen = z[p] | (z[p + 1] << 8);
    p += 4; // LEN + NLEN
    for (let i = 0; i < blen; i++) raw.push(z[p + i]);
    p += blen;
    if (final) break;
  }
  // Strip the per-row filter byte (all 0 = none).
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (1 + stride)]).toBe(0);
    for (let i = 0; i < stride; i++) rgba[y * stride + i] = raw[y * (1 + stride) + 1 + i];
  }
  return { width, height, rgba };
}

describe('encodePng', () => {
  it('produces a valid PNG that round-trips the pixels', () => {
    const w = 3;
    const h = 2;
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      255, 255, 0, 128, 0, 255, 255, 255, 255, 255, 255, 0,
    ]);
    const png = encodePng(rgba, w, h);
    const out = decode(png);
    expect(out.width).toBe(w);
    expect(out.height).toBe(h);
    expect(Array.from(out.rgba)).toEqual(Array.from(rgba));
  });

  it('spans multiple stored blocks for large images (>64KB rows)', () => {
    // 200x100 RGBA = 80KB raw + filter bytes → more than one 64KB stored block.
    const w = 200;
    const h = 100;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7) & 0xff;
    const out = decode(encodePng(rgba, w, h));
    expect(out.width).toBe(w);
    expect(Array.from(out.rgba)).toEqual(Array.from(rgba));
  });

  it('rejects a too-small buffer', () => {
    expect(() => encodePng(new Uint8Array(4), 2, 2)).toThrow();
  });
});
