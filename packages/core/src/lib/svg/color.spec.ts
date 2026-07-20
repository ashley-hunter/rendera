import { parseColor } from './color';
import type { LinearRgba } from '../render-list';

// sRGB -> linear for a single 0-1 channel (mirror of the parser's transfer).
const toLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
const eqColor = (c: LinearRgba | null, r: number, g: number, b: number, a = 1): boolean =>
  c !== null && near(c.r, toLin(r)) && near(c.g, toLin(g)) && near(c.b, toLin(b)) && near(c.a, a);

describe('parseColor', () => {
  it('parses #rrggbb into linear light', () => {
    expect(eqColor(parseColor('#ff0000'), 1, 0, 0)).toBe(true);
    expect(eqColor(parseColor('#000000'), 0, 0, 0)).toBe(true);
  });

  it('expands #rgb and #rgba shorthand', () => {
    expect(eqColor(parseColor('#f00'), 1, 0, 0)).toBe(true);
    // #ff08 -> r=f(ff) g=f(ff) b=0(00) a=8(88): yellow at 0x88/0xff alpha.
    expect(eqColor(parseColor('#ff08'), 1, 1, 0, 0x88 / 0xff)).toBe(true);
  });

  it('parses rgb() with 0-255 and rgba() with alpha', () => {
    expect(eqColor(parseColor('rgb(255, 0, 0)'), 1, 0, 0)).toBe(true);
    expect(eqColor(parseColor('rgba(0, 255, 0, 0.5)'), 0, 1, 0, 0.5)).toBe(true);
  });

  it('parses percentage rgb and the modern slash-alpha syntax', () => {
    expect(eqColor(parseColor('rgb(100%, 0%, 0%)'), 1, 0, 0)).toBe(true);
    expect(eqColor(parseColor('rgb(255 0 0 / 0.25)'), 1, 0, 0, 0.25)).toBe(true);
  });

  it('parses hsl()', () => {
    // hsl(0,100%,50%) is pure red.
    expect(eqColor(parseColor('hsl(0, 100%, 50%)'), 1, 0, 0)).toBe(true);
    // hsl(120,100%,50%) is pure green.
    expect(eqColor(parseColor('hsl(120, 100%, 50%)'), 0, 1, 0)).toBe(true);
  });

  it('parses named colours (full CSS table)', () => {
    expect(eqColor(parseColor('rebeccapurple'), 0x66 / 255, 0x33 / 255, 0x99 / 255)).toBe(true);
    expect(eqColor(parseColor('CornflowerBlue'), 0x64 / 255, 0x95 / 255, 0xed / 255)).toBe(true);
  });

  it('returns null for none and a clear colour for transparent', () => {
    expect(parseColor('none')).toBeNull();
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('resolves currentColor against the inherited colour', () => {
    const red: LinearRgba = { r: 1, g: 0, b: 0, a: 1 };
    expect(parseColor('currentColor', red)).toEqual(red);
    expect(parseColor('currentColor')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('throws on unrecognized input', () => {
    expect(() => parseColor('notacolor')).toThrow();
  });
});
