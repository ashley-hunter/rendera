/**
 * PNG encoder — RGBA pixels → PNG bytes. Owned and dependency-free.
 *
 * Emits a valid 8-bit RGBA (colour type 6) PNG: signature, IHDR, one IDAT, IEND.
 * The IDAT is a zlib stream whose DEFLATE payload uses **stored (uncompressed)
 * blocks** — larger files than a real compressor, but correct, tiny, and any
 * decoder reads it. The intent is a faithful raster export of a readback, not
 * minimal bytes. Pure and DOM-free (no canvas), so it's unit-tested in node.
 */

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32 over `bytes` (the zlib trailer checksum, over the *uncompressed* data). */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A PNG chunk: length + type + data + CRC(type+data). */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/** Wrap `raw` in a zlib stream with stored (uncompressed) DEFLATE blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const MAX = 0xffff;
  const nBlocks = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + raw.length + nBlocks * 5 + 4);
  let o = 0;
  out[o++] = 0x78; // zlib CMF (deflate, 32K window)
  out[o++] = 0x01; // FLG (no dict, fastest)
  for (let start = 0; start < raw.length || start === 0; start += MAX) {
    const len = Math.min(MAX, raw.length - start);
    const final = start + len >= raw.length ? 1 : 0;
    out[o++] = final; // BFINAL + BTYPE=00 (stored)
    out[o++] = len & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(start, start + len), o);
    o += len;
    if (len === 0) break;
  }
  const dv = new DataView(out.buffer);
  dv.setUint32(o, adler32(raw));
  o += 4;
  return out.subarray(0, o);
}

/**
 * Encode `width`×`height` 8-bit RGBA pixels (row-major, top-to-bottom) into PNG
 * bytes. `rgba` must hold at least `width*height*4` bytes.
 */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  if (width < 1 || height < 1) throw new Error('png: width and height must be >= 1');
  if (rgba.length < width * height * 4) throw new Error('png: rgba is smaller than width*height*4');

  // Each scanline is prefixed with a filter byte (0 = none).
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const ro = y * (1 + stride);
    raw[ro] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), ro + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}
