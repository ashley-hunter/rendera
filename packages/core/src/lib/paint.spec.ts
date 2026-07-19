import {
  normalizedStops,
  paintKind,
  sampleRamp,
  spreadIndex,
  type LinearGradient,
} from './paint';

const linear = (
  stops: LinearGradient['stops'],
  extra: Partial<LinearGradient> = {}
): LinearGradient => ({
  type: 'linear-gradient',
  start: { x: 0, y: 0 },
  end: { x: 1, y: 0 },
  stops,
  ...extra,
});

describe('paintKind / spreadIndex', () => {
  it('tags paints and spreads numerically', () => {
    expect(paintKind({ type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } })).toBe(0);
    expect(paintKind(linear([]))).toBe(1);
    expect(spreadIndex(undefined)).toBe(0);
    expect(spreadIndex('repeat')).toBe(1);
    expect(spreadIndex('reflect')).toBe(2);
  });
});

describe('normalizedStops', () => {
  it('sorts, clamps, and makes offsets monotonic', () => {
    const s = normalizedStops([
      { offset: 1.5, color: { r: 1, g: 0, b: 0, a: 1 } },
      { offset: -0.2, color: { r: 0, g: 1, b: 0, a: 1 } },
    ]);
    expect(s.map((x) => x.offset)).toEqual([0, 1]);
    expect(s[0].color.g).toBe(1); // the -0.2 (green) sorts first
  });

  it('synthesizes a two-endpoint ramp from zero or one stop', () => {
    expect(normalizedStops([])).toHaveLength(2);
    const one = normalizedStops([{ offset: 0.5, color: { r: 0.2, g: 0.4, b: 0.6, a: 1 } }]);
    expect(one).toHaveLength(2);
    expect(one[0].color).toEqual(one[1].color);
  });
});

describe('sampleRamp', () => {
  const g = linear([
    { offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
    { offset: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
  ]);

  it('interpolates linearly between stops and clamps outside', () => {
    expect(sampleRamp(g, 0.5).r).toBeCloseTo(0.5, 6);
    expect(sampleRamp(g, -1).r).toBeCloseTo(0, 6);
    expect(sampleRamp(g, 2).r).toBeCloseTo(1, 6);
  });

  it('OKLab interpolation stays in gamut and hits the endpoints exactly', () => {
    const ok = linear(
      [
        { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
      { interpolation: 'oklab' }
    );
    const end0 = sampleRamp(ok, 0);
    expect(end0.r).toBeCloseTo(1, 4);
    expect(end0.b).toBeCloseTo(0, 4);
    const mid = sampleRamp(ok, 0.5);
    // A perceptual red->blue midpoint carries both channels, none negative.
    expect(mid.r).toBeGreaterThan(0);
    expect(mid.b).toBeGreaterThan(0);
    expect(Math.min(mid.r, mid.g, mid.b)).toBeGreaterThanOrEqual(-0.01);
  });
});
