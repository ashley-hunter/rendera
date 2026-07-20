import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathBounds, pathEdges, toQuadraticPath } from '../path';
import { resolveOverlaps } from '../boolean';
import { strokePath } from '../stroke';
import { RenderaFont } from './font';

// The round join emits only the outer arc across the actual turn (and none at
// all where the offset segments already meet within tolerance), instead of a
// full disc at every flattened vertex. That kept a stroked glyph from exploding
// to ~17k edges (a full 18-edge disc at each of ~1k smooth-curve vertices), the
// dominant cost of stroked text at high zoom. Guard against that regressing.
describe('stroke edge count stays bounded', () => {
  it('does not emit a join disc at every flattened vertex', async () => {
    const p = fileURLToPath(new URL('./__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
    const d = readFileSync(p);
    const font = await RenderaFont.load(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    for (const ch of ['e', 'o', 'V', 's']) {
      const raw = font.glyphPath(font.shape(ch)[0].glyphId);
      const b = pathBounds(raw)!;
      const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
      const tol = Math.min(0.5, Math.max(0.02, diag * 0.0004));
      const strokeEdges = pathEdges(strokePath(resolveOverlaps(raw), { width: 26, join: 'round' }, tol)).length;
      // Segment rectangles dominate now (~a few thousand); the join blow-up
      // (~17k) must not return.
      expect(strokeEdges).toBeLessThan(6000);
    }
  });
});
