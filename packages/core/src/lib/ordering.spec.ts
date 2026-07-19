import {
  generateKeyBetween,
  generateNKeysBetween,
  validateOrderKey,
} from './ordering';

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('validateOrderKey', () => {
  it('accepts well-formed keys', () => {
    expect(() => validateOrderKey('V')).not.toThrow();
    expect(() => validateOrderKey('GV')).not.toThrow();
  });

  it('rejects empty, trailing-zero, and invalid-digit keys', () => {
    expect(() => validateOrderKey('')).toThrow();
    expect(() => validateOrderKey('V0')).toThrow();
    expect(() => validateOrderKey('a-b')).toThrow();
  });
});

describe('generateKeyBetween', () => {
  it('produces a valid first key from two open bounds', () => {
    const k = generateKeyBetween(null, null);
    expect(() => validateOrderKey(k)).not.toThrow();
  });

  it('orders a < mid < b', () => {
    const a = generateKeyBetween(null, null);
    const after = generateKeyBetween(a, null);
    const before = generateKeyBetween(null, a);
    const mid = generateKeyBetween(a, after);
    expect(before < a).toBe(true);
    expect(a < mid).toBe(true);
    expect(mid < after).toBe(true);
  });

  it('rejects a >= b', () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    expect(() => generateKeyBetween(b, a)).toThrow();
    expect(() => generateKeyBetween(a, a)).toThrow();
  });

  it('keeps append order strictly ascending', () => {
    let prev: string | null = null;
    let last: string | null = null;
    for (let i = 0; i < 200; i++) {
      const k = generateKeyBetween(last, null);
      if (prev !== null) {
        expect(prev < k).toBe(true);
      }
      prev = k;
      last = k;
    }
  });

  it('keeps prepend order strictly descending', () => {
    let first: string | null = null;
    let prev: string | null = null;
    for (let i = 0; i < 200; i++) {
      const k = generateKeyBetween(null, first);
      if (prev !== null) {
        expect(k < prev).toBe(true);
      }
      prev = k;
      first = k;
    }
  });

  it('can subdivide the same gap repeatedly', () => {
    const lo = generateKeyBetween(null, null);
    let hi = generateKeyBetween(lo, null);
    for (let i = 0; i < 200; i++) {
      const mid = generateKeyBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      hi = mid;
    }
  });
});

describe('generateNKeysBetween', () => {
  it('returns n strictly-ascending keys within the bounds', () => {
    for (const n of [0, 1, 2, 5, 17]) {
      const keys = generateNKeysBetween(null, null, n);
      expect(keys).toHaveLength(n);
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i - 1] < keys[i]).toBe(true);
      }
      keys.forEach((k) => expect(() => validateOrderKey(k)).not.toThrow());
    }
  });

  it('respects explicit bounds', () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    const keys = generateNKeysBetween(a, b, 10);
    expect(a < keys[0]).toBe(true);
    expect(keys[keys.length - 1] < b).toBe(true);
  });
});

describe('fractional ordering property test', () => {
  it('stays globally sorted and unique across random insertions', () => {
    const rand = prng(0xc0ffee);
    const keys: string[] = [];
    for (let i = 0; i < 500; i++) {
      const at = Math.floor(rand() * (keys.length + 1));
      const lo = at > 0 ? keys[at - 1] : null;
      const hi = at < keys.length ? keys[at] : null;
      const key = generateKeyBetween(lo, hi);
      keys.splice(at, 0, key);
    }
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});
