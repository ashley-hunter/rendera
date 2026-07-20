/**
 * Text itemization — the segmentation HarfBuzz needs before shaping.
 *
 * HarfBuzz shapes one *uniform* run (single direction + single script). Real
 * text mixes both, so before shaping we (1) run the Unicode Bidirectional
 * Algorithm (UAX #9, via `bidi-js`) to resolve an embedding level per character
 * and (2) itemize into runs of uniform level *and* script (UAX #24, resolving
 * `Common`/`Inherited` characters into their neighbours' script). The layout
 * pass shapes each run, then reorders runs into visual order by level.
 */

// The shim provides ambient types for these untyped deps; the reference forces
// it into any consumer's program (e.g. the Angular Storybook build compiling
// core from source), not just core's own build.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./shims.d.ts" />
import bidiFactory from 'bidi-js';
import unicode from 'unicode-properties';

/** A maximal run of uniform bidi level and script — one HarfBuzz shaping call. */
export interface TextRun {
  /** Start char index within the line (UTF-16 code unit). */
  readonly start: number;
  /** End char index (exclusive). */
  readonly end: number;
  /** Resolved bidi embedding level (even = LTR, odd = RTL). */
  readonly level: number;
  /** Convenience: `level` is odd. */
  readonly rtl: boolean;
}

type Bidi = ReturnType<typeof bidiFactory>;
let bidiInstance: Bidi | null = null;
function bidi(): Bidi {
  return (bidiInstance ??= bidiFactory());
}

/**
 * A per-code-unit script array, with `Common`/`Inherited` characters resolved to
 * a neighbouring real script (forward first, then backfilling any leading run).
 */
function resolveScripts(line: string): string[] {
  const n = line.length;
  const raw = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const cp = line.codePointAt(i) ?? 0;
    raw[i] = unicode.getScript(cp);
    if (cp > 0xffff && i + 1 < n) {
      raw[i + 1] = raw[i]; // low surrogate shares the codepoint's script
      i++;
    }
  }
  const resolved = new Array<string>(n);
  let last = '';
  for (let i = 0; i < n; i++) {
    const s = raw[i];
    if (s && s !== 'Common' && s !== 'Inherited' && s !== 'Unknown') {
      last = s;
      resolved[i] = s;
    } else {
      resolved[i] = last; // may be '' if no real script seen yet
    }
  }
  let next = 'Latin';
  for (let i = n - 1; i >= 0; i--) {
    if (resolved[i]) {
      next = resolved[i];
    } else {
      resolved[i] = next; // fill a leading Common/Inherited run
    }
  }
  return resolved;
}

/**
 * Resolve embedding levels for `line` and split it into uniform (level, script)
 * runs, in logical order. `baseDirection` forces the paragraph direction; omit
 * for auto-detection (first strong character).
 */
export function itemize(
  line: string,
  baseDirection?: 'ltr' | 'rtl'
): { levels: Uint8Array; runs: TextRun[] } {
  if (line.length === 0) {
    return { levels: new Uint8Array(0), runs: [] };
  }
  const { levels } = bidi().getEmbeddingLevels(line, baseDirection);
  const scripts = resolveScripts(line);
  const runs: TextRun[] = [];
  let start = 0;
  for (let i = 1; i <= line.length; i++) {
    const boundary = i === line.length || levels[i] !== levels[start] || scripts[i] !== scripts[start];
    if (boundary) {
      const level = levels[start];
      runs.push({ start, end: i, level, rtl: (level & 1) === 1 });
      start = i;
    }
  }
  return { levels, runs };
}

/**
 * Reorder runs from logical to visual order per UAX #9 rule L2: from the highest
 * level down to the lowest odd level, reverse every contiguous span of runs at
 * that level or above. Mutates a copy; returns it.
 */
export function reorderRunsVisually<T extends { level: number }>(runs: readonly T[]): T[] {
  const visual = runs.slice();
  if (visual.length < 2) {
    return visual;
  }
  let max = 0;
  let minOdd = Number.MAX_SAFE_INTEGER;
  for (const r of visual) {
    max = Math.max(max, r.level);
    if (r.level & 1) {
      minOdd = Math.min(minOdd, r.level);
    }
  }
  if (minOdd === Number.MAX_SAFE_INTEGER) {
    return visual; // all LTR, nothing to reverse
  }
  for (let level = max; level >= minOdd; level--) {
    let i = 0;
    while (i < visual.length) {
      if (visual[i].level >= level) {
        let j = i;
        while (j < visual.length && visual[j].level >= level) {
          j++;
        }
        for (let lo = i, hi = j - 1; lo < hi; lo++, hi--) {
          const tmp = visual[lo];
          visual[lo] = visual[hi];
          visual[hi] = tmp;
        }
        i = j;
      } else {
        i++;
      }
    }
  }
  return visual;
}
