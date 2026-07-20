import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathBounds, pointInPath } from '../path';
import { RenderaFont } from './font';
import { generateGlyphMsdf, median } from './msdf';

async function loadTestFont(): Promise<RenderaFont> {
  const path = fileURLToPath(new URL('./__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
  const data = readFileSync(path);
  return RenderaFont.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

describe('median', () => {
  it('returns the middle of three values', () => {
    expect(median(0.1, 0.9, 0.5)).toBeCloseTo(0.5, 6);
    expect(median(1, 1, 0)).toBeCloseTo(1, 6);
    expect(median(0.2, 0.2, 0.2)).toBeCloseTo(0.2, 6);
  });
});

describe('generateGlyphMsdf', () => {
  let font: RenderaFont;
  beforeAll(async () => {
    font = await loadTestFont();
  });

  it('has no field for a blank glyph (space)', () => {
    const space = font.shape(' ')[0];
    const m = generateGlyphMsdf(font.glyphPath(space.glyphId), { upem: font.upem });
    expect(m.empty).toBe(true);
    expect(m.width).toBe(0);
  });

  /**
   * The strongest correctness check: reconstruct coverage from the field
   * (median → signed distance) at every interior pixel and compare inside/outside
   * to the true analytic fill. Agreement must be near-total away from the ~1px
   * anti-aliased edge band.
   */
  it('reconstructs glyph coverage that matches the analytic fill', () => {
    const emPx = 48;
    const pxRange = 6;
    const pad = Math.ceil(pxRange / 2) + 1;
    const scale = emPx / font.upem;

    for (const ch of ['A', 'e', 'g']) {
      const glyphId = font.shape(ch)[0].glyphId;
      const path = font.glyphPath(glyphId);
      const b = pathBounds(path);
      if (!b) throw new Error('no bounds');
      const m = generateGlyphMsdf(path, { upem: font.upem, emPx, pxRange });
      expect(m.empty).toBe(false);

      let agree = 0;
      let total = 0;
      let inkSeen = false;
      for (let j = 0; j < m.height; j++) {
        const fy = b.maxY - (j + 0.5 - pad) / scale;
        for (let i = 0; i < m.width; i++) {
          const fx = b.minX + (i + 0.5 - pad) / scale;
          const k = (j * m.width + i) * 4;
          const med = median(m.data[k], m.data[k + 1], m.data[k + 2]) / 255;
          const signed = med - 0.5;
          if (Math.abs(signed) < 0.12) {
            continue; // skip the AA edge band
          }
          const inside = signed > 0;
          if (inside) inkSeen = true;
          const truth = pointInPath(path, { x: fx, y: fy }, 'nonzero');
          total++;
          if (inside === truth) agree++;
        }
      }
      expect(inkSeen).toBe(true); // the glyph actually filled some pixels
      expect(agree / total).toBeGreaterThan(0.97);
    }
  });

  it('exposes plane bounds that bracket the glyph (with padding)', () => {
    const glyphId = font.shape('H')[0].glyphId;
    const path = font.glyphPath(glyphId);
    const b = pathBounds(path)!;
    const m = generateGlyphMsdf(path, { upem: font.upem, emPx: 40, pxRange: 4 });
    // Plane (em units) padded outward past the glyph's own extent.
    expect(m.plane.left).toBeLessThan(b.minX / font.upem);
    expect(m.plane.right).toBeGreaterThan(b.maxX / font.upem);
    expect(m.plane.top).toBeGreaterThan(b.maxY / font.upem);
    expect(m.plane.bottom).toBeLessThan(b.minY / font.upem);
  });
});
