import { encode8, linearToSrgb, srgbToLinear } from './color';

describe('sRGB transfer functions', () => {
  it('pins the endpoints', () => {
    expect(linearToSrgb(0)).toBeCloseTo(0, 9);
    expect(linearToSrgb(1)).toBeCloseTo(1, 9);
    expect(srgbToLinear(0)).toBeCloseTo(0, 9);
    expect(srgbToLinear(1)).toBeCloseTo(1, 9);
  });

  it('round-trips linear -> sRGB -> linear', () => {
    for (const x of [0.001, 0.05, 0.2, 0.5, 0.9]) {
      expect(srgbToLinear(linearToSrgb(x))).toBeCloseTo(x, 6);
    }
  });

  it('encodes mid-grey linear 0.5 to ~188/255', () => {
    expect(linearToSrgb(0.5)).toBeCloseTo(0.735357, 5);
    expect(encode8(linearToSrgb(0.5))).toBe(188);
  });

  it('clamps out-of-range values when encoding', () => {
    expect(encode8(-1)).toBe(0);
    expect(encode8(2)).toBe(255);
  });
});
