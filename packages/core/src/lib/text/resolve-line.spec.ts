import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveOverlaps } from '../boolean';
import { pathBounds, pointInPath } from '../path';
import { layoutTextNode } from './layout';
import { RenderaFont } from './font';
import type { TextNode } from '../node';

// resolveOverlaps must preserve the filled shape of EVERY glyph on a whole text
// line — the same as resolving each glyph alone. A regression here (a mid-line
// glyph mis-resolved into spurious edges) both changes the fill and, worse, made
// the stroke draw a diagonal through the letter.
describe('resolveOverlaps on a whole text line', () => {
  it('preserves the fill of every glyph in "Vector Type"', async () => {
    const p = fileURLToPath(new URL('./__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
    const d = readFileSync(p);
    const font = await RenderaFont.load(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    const node = {
      id: 'n', type: 'text', name: 't', text: 'Vector Type', fontId: 'f', fontSize: 96,
      transform: { translation: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, skew: 0 },
    } as unknown as TextNode;
    const raw = layoutTextNode(font, node).path;
    const resolved = resolveOverlaps(raw);
    const b = pathBounds(raw)!;
    let mismatch = 0;
    let total = 0;
    for (let y = b.minY + 0.23; y <= b.maxY; y += 1.6) {
      for (let x = b.minX + 0.17; x <= b.maxX; x += 1.6) {
        const inRaw = pointInPath(raw, { x, y }, 'nonzero');
        const inRes = pointInPath(resolved, { x, y }, 'nonzero');
        total++;
        if (inRaw !== inRes) mismatch++;
      }
    }
    // eslint-disable-next-line no-console
    if (mismatch > 5) console.log(`fill mismatch ${mismatch}/${total}`);
    // Only exact-boundary sampling slop should differ; a corrupted glyph is 100s.
    expect(mismatch).toBeLessThan(total * 0.001 + 5);
  }, 30000);
});
