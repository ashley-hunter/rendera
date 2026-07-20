import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MsdfAtlas } from './atlas';
import { RenderaFont } from './font';
import { median } from './msdf';

async function loadTestFont(): Promise<RenderaFont> {
  const path = fileURLToPath(new URL('./__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
  const data = readFileSync(path);
  return RenderaFont.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

/** Glyph ids for the distinct letters of `text` (excluding blanks). */
function glyphIds(font: RenderaFont, text: string): number[] {
  const ids = new Set<number>();
  for (const g of font.shape(text)) {
    ids.add(g.glyphId);
  }
  return [...ids];
}

describe('MsdfAtlas', () => {
  let font: RenderaFont;
  beforeAll(async () => {
    font = await loadTestFont();
  });

  it('packs glyph cells without overlap, inside the texture', () => {
    const atlas = new MsdfAtlas(font, { emPx: 40, initialSize: 512 });
    const placed = glyphIds(font, 'the quick brown fox jumps')
      .map((id) => atlas.glyph(id))
      .filter((g): g is NonNullable<typeof g> => g !== null);
    expect(placed.length).toBeGreaterThan(5);

    const { width, height } = atlas.texture;
    for (const g of placed) {
      expect(g.x).toBeGreaterThanOrEqual(0);
      expect(g.y).toBeGreaterThanOrEqual(0);
      expect(g.x + g.w).toBeLessThanOrEqual(width);
      expect(g.y + g.h).toBeLessThanOrEqual(height);
    }
    // Pairwise non-overlap.
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  it('caches: the same glyph returns the same placement', () => {
    const atlas = new MsdfAtlas(font, { emPx: 32 });
    const id = glyphIds(font, 'A')[0];
    expect(atlas.glyph(id)).toBe(atlas.glyph(id));
  });

  it('returns null for a blank glyph (space)', () => {
    const atlas = new MsdfAtlas(font, { emPx: 32 });
    const space = font.shape(' ')[0].glyphId;
    expect(atlas.glyph(space)).toBeNull();
  });

  it('grows (and repacks) when the initial atlas is too small', () => {
    // 64px atlas can't hold several 40px-em glyph cells -> forces growth.
    const atlas = new MsdfAtlas(font, { emPx: 40, initialSize: 64 });
    for (const id of glyphIds(font, 'Rendering')) {
      atlas.glyph(id);
    }
    expect(atlas.version).toBeGreaterThan(0);
    expect(atlas.texture.width).toBeGreaterThan(64);
    // Placements stay valid after repacking.
    const id = glyphIds(font, 'R')[0];
    const g = atlas.glyph(id)!;
    expect(g.x + g.w).toBeLessThanOrEqual(atlas.texture.width);
  });

  it('writes real field data into the cell (not blank)', () => {
    const atlas = new MsdfAtlas(font, { emPx: 40, initialSize: 512 });
    const g = atlas.glyph(glyphIds(font, 'H')[0])!;
    const { data, width } = atlas.texture;
    // Somewhere in the cell the reconstructed distance crosses the 0.5 edge.
    let sawInside = false;
    let sawOutside = false;
    for (let y = g.y; y < g.y + g.h; y++) {
      for (let x = g.x; x < g.x + g.w; x++) {
        const k = (y * width + x) * 4;
        const med = median(data[k], data[k + 1], data[k + 2]) / 255;
        if (med > 0.6) sawInside = true;
        if (med < 0.4) sawOutside = true;
      }
    }
    expect(sawInside && sawOutside).toBe(true);
  });
});
