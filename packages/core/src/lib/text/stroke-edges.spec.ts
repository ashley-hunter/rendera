import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathBounds, pathEdges, toQuadraticPath } from '../path';
import { resolveOverlaps } from '../boolean';
import { strokePath } from '../stroke';
import { RenderaFont } from './font';

// Stroking offsets curves as quadratics (a few exact edges per segment, like
// the fill), not by flattening to line-segment rectangles with a join disc at
// every vertex. That took a stroked glyph from ~17k edges to a couple hundred —
// the dominant cost of stroked text at high zoom. Guard against a regression to
// flattening.
describe('stroke edge count stays bounded', () => {
  it('offsets curves as curves, not thousands of facets', async () => {
    const p = fileURLToPath(new URL('./__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
    const d = readFileSync(p);
    const font = await RenderaFont.load(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    for (const ch of ['e', 'o', 'V', 's']) {
      const raw = font.glyphPath(font.shape(ch)[0].glyphId);
      const b = pathBounds(raw)!;
      const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
      const tol = Math.min(0.5, Math.max(0.02, diag * 0.0004));
      const strokeEdges = pathEdges(strokePath(resolveOverlaps(raw), { width: 26, join: 'round' }, tol)).length;
      // A curve-offset stroke is a few hundred edges; flattening was ~17k.
      expect(strokeEdges).toBeLessThan(800);
    }
  });
});
