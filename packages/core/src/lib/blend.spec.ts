import { BLEND_MODES, blendModeIndex, isSeparable, type BlendMode } from './blend';

describe('blend modes', () => {
  it('lists the full W3C set with Normal at index 0', () => {
    expect(BLEND_MODES).toHaveLength(16);
    expect(BLEND_MODES[0]).toBe('normal');
    expect(new Set(BLEND_MODES).size).toBe(16); // no duplicates
  });

  it('maps each mode to its canonical index', () => {
    BLEND_MODES.forEach((mode, i) => {
      expect(blendModeIndex(mode)).toBe(i);
    });
  });

  it('classifies the four non-separable modes', () => {
    const nonSeparable: BlendMode[] = ['hue', 'saturation', 'color', 'luminosity'];
    for (const mode of BLEND_MODES) {
      expect(isSeparable(mode)).toBe(!nonSeparable.includes(mode));
    }
  });
});
