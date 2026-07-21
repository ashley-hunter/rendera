import { niceStep, rulerTicks } from './ruler';

describe('niceStep', () => {
  it('rounds to 1/2/5 × a power of ten', () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.3)).toBe(1);
    expect(niceStep(1.6)).toBe(2);
    expect(niceStep(4)).toBe(5);
    expect(niceStep(8)).toBe(10);
    expect(niceStep(23)).toBe(20);
    expect(niceStep(64)).toBe(50);
    expect(niceStep(0.03)).toBeCloseTo(0.05);
  });

  it('defends against non-positive / non-finite input', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-5)).toBe(1);
    expect(niceStep(Infinity)).toBe(1);
  });
});

describe('rulerTicks', () => {
  it('lists the step multiples within the range', () => {
    expect(rulerTicks(0, 100, 25)).toEqual([0, 25, 50, 75, 100]);
    expect(rulerTicks(-30, 30, 20)).toEqual([-20, 0, 20]);
  });

  it('starts at the first multiple ≥ min', () => {
    expect(rulerTicks(12, 60, 20)).toEqual([20, 40, 60]);
  });

  it('guards against a runaway tiny step', () => {
    expect(rulerTicks(0, 1e9, 0.001)).toEqual([]);
    expect(rulerTicks(0, 10, 0)).toEqual([]);
    expect(rulerTicks(10, 0, 1)).toEqual([]); // inverted range
  });
});
