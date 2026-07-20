import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RenderaFont } from './font';

/** Load the bundled Crimson Pro fixture as a RenderaFont. */
export async function loadTestFont(): Promise<RenderaFont> {
  const path = fileURLToPath(new URL('./__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
  const data = readFileSync(path);
  return RenderaFont.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

describe('RenderaFont', () => {
  let font: RenderaFont;
  beforeAll(async () => {
    font = await loadTestFont();
  });

  it('reports vertical metrics in font units', () => {
    expect(font.upem).toBeGreaterThan(0);
    expect(font.metrics.ascender).toBeGreaterThan(0);
    expect(font.metrics.descender).toBeGreaterThan(0);
  });

  it('shapes standard ligatures (office -> "fi" ligature)', () => {
    const office = font.shape('office');
    expect(office.length).toBeLessThan('office'.length); // f-i merged
  });

  it('applies kerning (AV tighter than A + V apart)', () => {
    const av = font.shape('AV').reduce((s, g) => s + g.xAdvance, 0);
    const loose = font.shape('A')[0].xAdvance + font.shape('V')[0].xAdvance;
    expect(av).toBeLessThan(loose);
  });

  it('honours feature toggles (disabling liga stops the ligature)', () => {
    const on = font.shape('fi');
    const off = font.shape('fi', { features: ['-liga'] });
    expect(on.length).toBeLessThan(off.length);
  });

  it('extracts and caches glyph outlines (Y-up font units)', () => {
    const g = font.shape('A')[0].glyphId;
    const path = font.glyphPath(g);
    expect(path.subpaths.length).toBeGreaterThan(0);
    expect(path.subpaths[0].closed).toBe(true);
    expect(font.glyphPath(g)).toBe(path); // returned from cache
  });

  it('gives a blank glyph (space) no contours', () => {
    const space = font.shape(' ')[0];
    expect(font.glyphPath(space.glyphId).subpaths.length).toBe(0);
    expect(space.xAdvance).toBeGreaterThan(0);
  });
});
