import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathBounds, pointInPath, type Path } from '../path';
import { resolveOverlaps } from '../boolean';
import { strokePath } from '../stroke';
import { RenderaFont } from './font';

async function loadFont(): Promise<RenderaFont> {
  const p = fileURLToPath(new URL('./__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
  const d = readFileSync(p);
  return RenderaFont.load(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
}

const WIDTH = 26; // ~2.5px stroke at fontSize 96 (upem 1024)
const HALF = WIDTH / 2;
const GLYPHS = ['e', 'V', 'a', 'o', 's', 'R', 'B', 'g', 'A', 'W', 'k'];

/** Points the stroke covers that sit deep inside the filled glyph — whose whole
 * neighbourhood (radius > half-width) is interior. A wide interior seam (the
 * overlap artifact) shows here; a thin stem inked from both sides does not. */
function deepStroked(truth: Path, outline: Path): number {
  const b = pathBounds(truth);
  if (!b) return 0;
  const ring = HALF + 6;
  let n = 0;
  for (let y = b.minY + 0.37; y <= b.maxY; y += 8) {
    for (let x = b.minX + 0.53; x <= b.maxX; x += 8) {
      if (!pointInPath(truth, { x, y }, 'nonzero')) continue;
      let deep = true;
      for (let a = 0; a < 8; a++) {
        const rx = x + Math.cos((a * Math.PI) / 4) * ring;
        const ry = y + Math.sin((a * Math.PI) / 4) * ring;
        if (!pointInPath(truth, { x: rx, y: ry }, 'nonzero')) {
          deep = false;
          break;
        }
      }
      if (deep && pointInPath(outline, { x, y }, 'nonzero')) n++;
    }
  }
  return n;
}

describe('stroked glyph overlap removal', () => {
  let font: RenderaFont;
  beforeAll(async () => {
    font = await loadFont();
  });

  it('preserves the filled shape exactly', () => {
    for (const ch of GLYPHS) {
      const raw = font.glyphPath(font.shape(ch)[0].glyphId);
      const resolved = resolveOverlaps(raw);
      const b = pathBounds(raw);
      if (!b) throw new Error('no bounds');
      let mismatch = 0;
      for (let y = b.minY + 0.37; y <= b.maxY; y += 7) {
        for (let x = b.minX + 0.53; x <= b.maxX; x += 7) {
          if (pointInPath(raw, { x, y }, 'nonzero') !== pointInPath(resolved, { x, y }, 'nonzero')) mismatch++;
        }
      }
      expect(mismatch).toBe(0);
    }
  }, 30000);

  it('removes the interior stroke seam that overlapping contours create', () => {
    // The 'e' crossbar overlaps the body; the raw outline strokes the seam deep
    // inside the letter, resolving overlaps eliminates it — fill left untouched.
    const rawE = font.glyphPath(font.shape('e')[0].glyphId);
    const resolvedE = resolveOverlaps(rawE);
    const rawSeam = deepStroked(rawE, strokePath(rawE, { width: WIDTH, join: 'round' }, 0.4));
    const fixedSeam = deepStroked(rawE, strokePath(resolvedE, { width: WIDTH, join: 'round' }, 0.4));
    expect(rawSeam).toBeGreaterThan(10); // the artifact is real and large
    expect(fixedSeam).toBe(0); // and gone after resolving
  }, 30000);

  it('never strokes deeper into any glyph than the raw outline did', () => {
    for (const ch of GLYPHS) {
      const raw = font.glyphPath(font.shape(ch)[0].glyphId);
      const resolved = resolveOverlaps(raw);
      const rawN = deepStroked(raw, strokePath(raw, { width: WIDTH, join: 'round' }, 0.4));
      const fixedN = deepStroked(raw, strokePath(resolved, { width: WIDTH, join: 'round' }, 0.4));
      expect(fixedN).toBeLessThanOrEqual(rawN);
    }
  }, 30000);

  it('resolves each glyph fast enough for the render path', () => {
    for (const ch of GLYPHS) {
      const raw = font.glyphPath(font.shape(ch)[0].glyphId);
      const t0 = performance.now();
      resolveOverlaps(raw);
      expect(performance.now() - t0).toBeLessThan(20);
    }
  }, 30000);
});
