import { itemize, reorderRunsVisually } from './itemize';

describe('itemize', () => {
  it('treats pure LTR text as one level-0 run', () => {
    const { runs } = itemize('hello world');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 0, end: 11, level: 0, rtl: false });
  });

  it('resolves RTL script to odd levels', () => {
    const { runs } = itemize('שלום'); // "שלום" (Hebrew)
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.rtl)).toBe(true);
  });

  it('splits mixed-direction text into multiple runs', () => {
    // Latin + Hebrew + Latin -> at least an LTR/RTL/LTR split.
    const { runs } = itemize('abc שלום def');
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.some((r) => r.rtl)).toBe(true);
    expect(runs.some((r) => !r.rtl)).toBe(true);
  });

  it('returns nothing for an empty line', () => {
    expect(itemize('').runs).toHaveLength(0);
  });
});

describe('reorderRunsVisually', () => {
  it('leaves an all-LTR sequence unchanged', () => {
    const runs = [{ level: 0, id: 'a' }, { level: 0, id: 'b' }];
    expect(reorderRunsVisually(runs).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('reverses a pair of adjacent RTL runs (L2)', () => {
    // Logical [LTR, RTL, RTL, LTR] -> the two RTL runs swap visually.
    const runs = [
      { level: 0, id: 'a' },
      { level: 1, id: 'b' },
      { level: 1, id: 'c' },
      { level: 0, id: 'd' },
    ];
    expect(reorderRunsVisually(runs).map((r) => r.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('reverses nested higher levels before lower ones', () => {
    // level-2 run embedded inside a level-1 span.
    const runs = [
      { level: 1, id: 'a' },
      { level: 2, id: 'b' },
      { level: 1, id: 'c' },
    ];
    // L2: reverse level>=2 (b alone), then level>=1 (whole) -> c,b,a
    expect(reorderRunsVisually(runs).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});
