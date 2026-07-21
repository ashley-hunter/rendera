/**
 * Ruler tick maths — choosing human-friendly tick spacings and enumerating the
 * ticks across a visible world range. Pure and unit-tested; the editor projects
 * the returned world coordinates to screen for its rulers and grid.
 */

/**
 * Round a raw step up to the nearest "nice" number — 1, 2, or 5 times a power of
 * ten (so ticks land on 1/2/5/10/20/50/… rather than arbitrary values). Used to
 * pick a tick spacing from a target on-screen pixel gap.
 */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow; // in [1, 10)
  const nice = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nice * pow;
}

/**
 * The multiples of `step` lying within `[min, max]` (inclusive), as world
 * coordinates. Returns an empty array for a non-positive step or a range that
 * would need more than `limit` ticks (a guard against a runaway tiny step).
 */
export function rulerTicks(min: number, max: number, step: number, limit = 2000): number[] {
  if (!(step > 0) || !Number.isFinite(step) || max < min) return [];
  if ((max - min) / step > limit) return [];
  const out: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let v = first; v <= max + step * 1e-6; v += step) {
    // Snap tiny float drift so labels read cleanly (e.g. 0 not 1e-13).
    out.push(Math.round(v * 1e6) / 1e6);
  }
  return out;
}
