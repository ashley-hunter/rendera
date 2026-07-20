import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RenderaFont } from './font';
import { generateGlyphMsdf, median, type GlyphMsdf } from './msdf';

async function loadTestFont(): Promise<RenderaFont> {
  const path = fileURLToPath(new URL('./__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
  const data = readFileSync(path);
  return RenderaFont.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

const THRESHOLD = 127.5;
const texel = (m: GlyphMsdf, x: number, y: number): number[] => {
  const k = (y * m.width + x) * 4;
  return [m.data[k], m.data[k + 1], m.data[k + 2]];
};

/**
 * Count "false-edge" texel pairs: adjacent texels whose reconstructed medians
 * agree on inside/outside, yet the linear interpolant's median crosses the
 * threshold in between. That is exactly what the GPU's bilinear filtering paints
 * as a one-texel hole inside a glyph (or a nub outside it) — the notch artifact
 * that shows at sharp features (apexes, serifs, stem/crossbar junctions) once a
 * feature narrows to roughly a texel. Error correction must drive this to zero.
 */
function countFalseEdges(m: GlyphMsdf): number {
  let bad = 0;
  const check = (a: number[], b: number[]): void => {
    const medA = median(a[0], a[1], a[2]);
    const medB = median(b[0], b[1], b[2]);
    const bothIn = medA > THRESHOLD && medB > THRESHOLD;
    const bothOut = medA < THRESHOLD && medB < THRESHOLD;
    if (!bothIn && !bothOut) return; // genuine edge crossing — leave it
    for (let s = 1; s < 16; s++) {
      const t = s / 16;
      const mm = median(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]));
      if ((bothIn && mm < THRESHOLD) || (bothOut && mm > THRESHOLD)) {
        bad++;
        return;
      }
    }
  };
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (x + 1 < m.width) check(texel(m, x, y), texel(m, x + 1, y));
      if (y + 1 < m.height) check(texel(m, x, y), texel(m, x, y + 1));
    }
  }
  return bad;
}

describe('MSDF error correction', () => {
  let font: RenderaFont;
  beforeAll(async () => {
    font = await loadTestFont();
  });

  // Regression for interior holes / exterior nubs reported when text is small
  // (the MSDF routing) and the atlas is heavily minified. Sharp-cornered glyphs
  // at small atlas em sizes are where channel clashes bite. Without error
  // correction this font produces hundreds of false edges across these cases.
  it('leaves no false-edge notches across sizes and sharp glyphs', () => {
    const glyphs = ['A', 'V', 'W', 'M', 'N', 'Y', 'K', 'X', 'Z', 'R', 'B', 'w', 'x', 'y', 'k', 'e', 'g', 'a', 's'];
    for (const emPx of [20, 24, 28, 32, 40]) {
      for (const ch of glyphs) {
        const glyphId = font.shape(ch)[0].glyphId;
        const path = font.glyphPath(glyphId);
        const m = generateGlyphMsdf(path, { upem: font.upem, emPx, pxRange: 4 });
        expect(countFalseEdges(m)).toBe(0);
      }
    }
  });
});
