/**
 * Fractional indexing (a.k.a. "order keys" / LexoRank-style).
 *
 * Sibling z-order is stored as a string key on each node. To move a node
 * between two others we generate a key that sorts strictly *between* their
 * keys — so a reorder touches only the moved node (O(1)) and never renumbers
 * its siblings. Keys compare with plain lexicographic string comparison.
 *
 * The digit alphabet is base-62 in ASCII order, so `a < b` as JavaScript
 * strings iff `a` sorts before `b` as fractions. Keys never end in the lowest
 * digit ("0"), which is what lets any gap be subdivided indefinitely.
 *
 * The midpoint routine follows the well-known reference algorithm for
 * fractional indexing (David Greenspan), using the fractional part only.
 */

const DIGITS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];

/** An order key: a non-empty base-62 string that does not end in "0". */
export type OrderKey = string;

/** Throw if `key` is not a well-formed order key. */
export function validateOrderKey(key: string): void {
  if (key === '') {
    throw new Error('order key must not be empty');
  }
  for (const ch of key) {
    if (DIGITS.indexOf(ch) === -1) {
      throw new Error(`invalid order-key digit: ${JSON.stringify(ch)}`);
    }
  }
  if (key.slice(-1) === ZERO) {
    throw new Error(`order key must not end in "${ZERO}": ${key}`);
  }
}

/**
 * Return a key strictly between `a` and `b` in the fractional number line.
 * `a` is the empty string for "negative infinity"; `b` is `null` for
 * "positive infinity". Requires `a < b` and that neither ends in "0".
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new Error(`${a} >= ${b}`);
  }
  if (a.slice(-1) === ZERO || (b !== null && b.slice(-1) === ZERO)) {
    throw new Error('order key must not end in a zero digit');
  }

  if (b !== null) {
    // Strip the longest common prefix, padding `a` with implied zeros.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
  }

  const digitA = a === '' ? 0 : DIGITS.indexOf(a[0]);
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;

  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return DIGITS[midDigit];
  }

  // First digits are consecutive.
  if (b !== null && b.length > 1) {
    return b.slice(0, 1);
  }
  // `b` is null or a single digit: keep `a`'s first digit and recurse to the
  // right (e.g. midpoint('49', '5') -> '4' + midpoint('9', null) -> '495').
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/**
 * Generate an order key that sorts strictly between `a` and `b`.
 * Pass `null` for an open bound: `generateKeyBetween(null, first)` prepends,
 * `generateKeyBetween(last, null)` appends, `generateKeyBetween(null, null)`
 * makes the first key in an empty list.
 */
export function generateKeyBetween(
  a: string | null,
  b: string | null
): OrderKey {
  if (a !== null) {
    validateOrderKey(a);
  }
  if (b !== null) {
    validateOrderKey(b);
  }
  if (a !== null && b !== null && a >= b) {
    throw new Error(`invalid order: ${a} >= ${b}`);
  }
  if (a === null && b === null) {
    return DIGITS[Math.floor(DIGITS.length / 2)];
  }
  if (a === null) {
    return midpoint('', b as string);
  }
  if (b === null) {
    return midpoint(a, null);
  }
  return midpoint(a, b);
}

/**
 * Generate `n` order keys evenly spaced strictly between `a` and `b`, in
 * ascending order. Splits recursively so keys stay short.
 */
export function generateNKeysBetween(
  a: string | null,
  b: string | null,
  n: number
): OrderKey[] {
  if (n < 0 || !Number.isInteger(n)) {
    throw new Error(`n must be a non-negative integer, got ${n}`);
  }
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [generateKeyBetween(a, b)];
  }
  if (b === null) {
    let c = generateKeyBetween(a, b);
    const result = [c];
    for (let i = 1; i < n; i++) {
      c = generateKeyBetween(c, b);
      result.push(c);
    }
    return result;
  }
  if (a === null) {
    let c = generateKeyBetween(a, b);
    const result = [c];
    for (let i = 1; i < n; i++) {
      c = generateKeyBetween(a, c);
      result.push(c);
    }
    result.reverse();
    return result;
  }
  const mid = Math.floor(n / 2);
  const c = generateKeyBetween(a, b);
  return [
    ...generateNKeysBetween(a, c, mid),
    c,
    ...generateNKeysBetween(c, b, n - mid - 1),
  ];
}
