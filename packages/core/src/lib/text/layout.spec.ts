import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathBounds } from '../path';
import { RenderaFont } from './font';
import { layoutText } from './layout';

async function loadTestFont(): Promise<RenderaFont> {
  const path = fileURLToPath(new URL('./__fixtures__/CrimsonPro-Regular.ttf', import.meta.url));
  const data = readFileSync(path);
  return RenderaFont.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

describe('layoutText', () => {
  let font: RenderaFont;
  beforeAll(async () => {
    font = await loadTestFont();
  });

  it('bakes a single line into local-space glyph outlines', () => {
    const l = layoutText(font, 'Waffle', { fontSize: 100 });
    expect(l.lineCount).toBe(1);
    expect(l.width).toBeGreaterThan(0);
    expect(l.path.subpaths.length).toBeGreaterThan(3);
    // Outlines sit within the block: x in [0, width], y in [0, height].
    const b = pathBounds(l.path);
    expect(b).not.toBeNull();
    expect(b!.minX).toBeGreaterThanOrEqual(-1);
    expect(b!.maxX).toBeLessThanOrEqual(l.width + 1);
    expect(b!.minY).toBeGreaterThanOrEqual(-1);
    expect(b!.maxY).toBeLessThanOrEqual(l.height + 1);
  });

  it('scales width with font size', () => {
    const small = layoutText(font, 'scale', { fontSize: 20 });
    const big = layoutText(font, 'scale', { fontSize: 80 });
    expect(big.width).toBeGreaterThan(small.width * 3.5);
  });

  it('widens with letter spacing', () => {
    const tight = layoutText(font, 'spacing', { fontSize: 40 });
    const loose = layoutText(font, 'spacing', { fontSize: 40, letterSpacing: 10 });
    expect(loose.width).toBeGreaterThan(tight.width);
  });

  it('stacks lines on explicit breaks', () => {
    const one = layoutText(font, 'Line', { fontSize: 50 });
    const three = layoutText(font, 'Line\nLine\nLine', { fontSize: 50 });
    expect(three.lineCount).toBe(3);
    expect(three.height).toBeGreaterThan(one.height * 2.5);
    // The widest line drives block width; equal single-line width here.
    expect(three.width).toBeCloseTo(one.width, 3);
  });

  it('right-aligns a short line flush to the block width', () => {
    // Two lines of different widths; the short one shifts right when aligned.
    const text = 'i\nwwwww';
    const left = layoutText(font, text, { fontSize: 60, align: 'left' });
    const right = layoutText(font, text, { fontSize: 60, align: 'right' });
    // Isolate the first line's glyphs (y within the first line band).
    const firstLineMaxX = (l: typeof left): number => {
      let max = -Infinity;
      for (const sp of l.path.subpaths) {
        const ys = [sp.start.y, ...sp.segments.map((s) => s.to.y)];
        if (Math.min(...ys) < l.lineHeight) {
          max = Math.max(max, sp.start.x, ...sp.segments.map((s) => s.to.x));
        }
      }
      return max;
    };
    // Left-aligned 'i' ends near its own width; right-aligned it ends near block width.
    expect(firstLineMaxX(right)).toBeGreaterThan(firstLineMaxX(left) + left.width * 0.4);
  });
});
