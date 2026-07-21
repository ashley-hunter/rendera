import { hexToLinear, linearToHex } from './color';

describe('linearToHex / hexToLinear', () => {
  it('round-trips pure primaries and greys through the sRGB transfer', () => {
    // sRGB white/black map to linear 1/0 exactly.
    expect(linearToHex({ r: 1, g: 1, b: 1, a: 1 })).toBe('#ffffff');
    expect(linearToHex({ r: 0, g: 0, b: 0, a: 1 })).toBe('#000000');
    // #ff0000 is linear (1,0,0).
    expect(hexToLinear('#ff0000')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });

  it('applies the gamma curve (mid-grey is not linear 0.5)', () => {
    const grey = hexToLinear('#808080');
    // sRGB 0.5 → linear ~0.214, well below 0.5.
    expect(grey.r).toBeGreaterThan(0.2);
    expect(grey.r).toBeLessThan(0.23);
    // And it round-trips back to the same byte.
    expect(linearToHex(grey)).toBe('#808080');
  });

  it('round-trips a full sweep of byte values', () => {
    for (let v = 0; v <= 255; v += 17) {
      const hex = `#${v.toString(16).padStart(2, '0')}0000`;
      expect(linearToHex(hexToLinear(hex))).toBe(hex);
    }
  });

  it('expands short hex and honours the alpha override', () => {
    expect(hexToLinear('#f00')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(hexToLinear('#ffffff', 0.5).a).toBe(0.5);
    // 8-digit hex parses its own alpha.
    expect(hexToLinear('#00000080').a).toBeCloseTo(128 / 255);
  });
});
