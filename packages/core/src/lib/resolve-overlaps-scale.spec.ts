import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveOverlaps } from './boolean';
import { pathBounds, pointInPath, transformPath, type Path } from './path';
import { RenderaFont } from './text/font';

async function loadFont(): Promise<RenderaFont> {
  const p = fileURLToPath(new URL('./text/__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
  const d = readFileSync(p);
  return RenderaFont.load(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
}

const scale = (path: Path, k: number): Path => transformPath(path, { a: k, b: 0, c: 0, d: k, e: 0, f: 0 });

describe('resolveOverlaps is scale-invariant', () => {
  let font: RenderaFont;
  beforeAll(async () => {
    font = await loadFont();
  });

  // The tolerances are absolute, so a naive implementation shatters a small
  // (em-scaled) path into dozens of fragments — the cause of the broken stroke
  // on the deployed text. Normalizing internally must make the topology (subpath
  // count) and the filled region identical at any scale.
  it('gives the same topology and fill at tiny, unit, and huge scales', () => {
    for (const ch of ['e', 'a', 'o', 's', 'g', 'B']) {
      const glyph = font.glyphPath(font.shape(ch)[0].glyphId); // ~1000 units
      const counts = [0.04, 1, 25].map((k) => resolveOverlaps(scale(glyph, k)).subpaths.length);
      // eslint-disable-next-line no-console
      if (counts[0] !== counts[1] || counts[1] !== counts[2]) console.log(`"${ch}" counts=${counts}`);
      expect(counts[0]).toBe(counts[1]);
      expect(counts[2]).toBe(counts[1]);

      // Fill preserved at em-scale (the regime that broke): resolved vs raw.
      const em = 96 / font.upem;
      const emGlyph = scale(glyph, em);
      const resolved = resolveOverlaps(emGlyph);
      const b = pathBounds(emGlyph)!;
      let mismatch = 0;
      for (let y = b.minY + 0.13; y <= b.maxY; y += 0.7)
        for (let x = b.minX + 0.17; x <= b.maxX; x += 0.7)
          if (pointInPath(emGlyph, { x, y }, 'nonzero') !== pointInPath(resolved, { x, y }, 'nonzero')) mismatch++;
      // Allow a couple of exact-boundary sample flips (half-open rule slop); a
      // real fill change (the shattering bug) is dozens+.
      expect(mismatch).toBeLessThanOrEqual(2);
    }
  });
});
