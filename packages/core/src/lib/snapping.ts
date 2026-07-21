/**
 * Alignment snapping — the "smart guides" an editor draws while a drag moves a
 * selection, as pure functions over a `SceneDocument` (DOM-free, unit-tested).
 *
 * Given a set of moving nodes and a proposed world-space translation, `snapMove`
 * nudges that translation so the moving selection's box edges/centre line up with
 * nearby shapes' edges/centres, and returns the alignment guides to draw. Each
 * axis snaps independently to the *closest* candidate within `threshold` world
 * units (so the pull is symmetric and never fights itself), and only when a snap
 * actually lands does the delta change — free movement everywhere else.
 *
 * The threshold is a world distance; a caller working in screen space passes
 * `screenPixels / zoom` so the snap "feel" is constant on screen at any zoom.
 */

import type { Bounds } from './bounds';
import type { SceneDocument } from './document';
import { topLevelAncestor } from './hit-test';
import type { NodeId } from './id';
import { vec2, type Vec2 } from './vec2';

/**
 * A single alignment guide: a line at `position` on `axis` (`x` → a vertical
 * line at that x; `y` → a horizontal line at that y), spanning `[start, end]` on
 * the other axis so it visibly bridges the moving box and the shape it aligns to.
 */
export interface SnapGuide {
  readonly axis: 'x' | 'y';
  readonly position: number;
  readonly start: number;
  readonly end: number;
}

/** Options for `snapMove`. */
export interface SnapOptions {
  /** Snap range in world units (edges/centres within this distance are pulled). */
  readonly threshold: number;
  /** Also snap box centres, not only edges (default true). */
  readonly centers?: boolean;
  /** Explicit target boxes to align to; defaults to every root-level node not
   *  being moved. Pass this to align against a custom set (e.g. the canvas). */
  readonly targets?: readonly Bounds[];
}

/** The snapped translation plus the guides to draw for it. */
export interface SnapResult {
  readonly delta: Vec2;
  readonly guides: readonly SnapGuide[];
}

const translateBounds = (b: Bounds, dx: number, dy: number): Bounds => ({
  minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy,
});

/** The three snap lines of a box on an axis: low edge, centre, high edge. */
function lines(lo: number, hi: number, centers: boolean): number[] {
  return centers ? [lo, (lo + hi) / 2, hi] : [lo, hi];
}

interface AxisSnap {
  /** Adjustment to add to the delta on this axis. */
  readonly adjust: number;
  /** The world coordinate the moving box snapped to. */
  readonly position: number;
}

/** Closest edge/centre alignment of `[mLo, mHi]` to any target range, or null. */
function axisSnap(
  mLo: number,
  mHi: number,
  targets: readonly [number, number][],
  threshold: number,
  centers: boolean
): AxisSnap | null {
  const movingLines = lines(mLo, mHi, centers);
  let bestDist = threshold + 1e-9;
  let best: AxisSnap | null = null;
  for (const [tLo, tHi] of targets) {
    for (const tl of lines(tLo, tHi, centers)) {
      for (const ml of movingLines) {
        const d = Math.abs(tl - ml);
        if (d < bestDist) {
          bestDist = d;
          best = { adjust: tl - ml, position: tl };
        }
      }
    }
  }
  return best;
}

/** The root-level nodes' world boxes, excluding the ones being moved. */
function defaultTargets(doc: SceneDocument, movingIds: Iterable<NodeId>): Bounds[] {
  const skip = new Set<NodeId>();
  for (const id of movingIds) skip.add(topLevelAncestor(doc, id));
  const out: Bounds[] = [];
  for (const child of doc.getChildren(doc.root.id)) {
    if (skip.has(child.id)) continue;
    const b = doc.getWorldBounds(child.id);
    if (b) out.push(b);
  }
  return out;
}

/**
 * Snap a proposed world translation of `movingIds` so the selection's box aligns
 * to nearby shapes, returning the adjusted `delta` and the guides to draw. When
 * nothing is within `threshold`, `delta` is returned unchanged with no guides.
 */
export function snapMove(
  doc: SceneDocument,
  movingIds: Iterable<NodeId>,
  moving: Bounds | null,
  delta: Vec2,
  options: SnapOptions
): SnapResult {
  const ids = [...movingIds];
  if (!moving || ids.length === 0) return { delta, guides: [] };
  const centers = options.centers ?? true;
  const targets = options.targets ?? defaultTargets(doc, ids);
  if (targets.length === 0) return { delta, guides: [] };

  const box = translateBounds(moving, delta.x, delta.y);
  const sx = axisSnap(box.minX, box.maxX, targets.map((t) => [t.minX, t.maxX]), options.threshold, centers);
  const sy = axisSnap(box.minY, box.maxY, targets.map((t) => [t.minY, t.maxY]), options.threshold, centers);

  const out = vec2(delta.x + (sx?.adjust ?? 0), delta.y + (sy?.adjust ?? 0));
  const snapped = translateBounds(moving, out.x, out.y);

  const guides: SnapGuide[] = [];
  if (sx) guides.push(guideFor('x', sx.position, snapped, targets, (t) => [t.minX, t.maxX], (t) => [t.minY, t.maxY]));
  if (sy) guides.push(guideFor('y', sy.position, snapped, targets, (t) => [t.minY, t.maxY], (t) => [t.minX, t.maxX]));
  return { delta: out, guides };
}

/**
 * Build the guide line at `position` on `axis`. It spans (on the perpendicular
 * axis) the union of the moving box and every target that shares this line, so
 * the drawn line visibly connects the aligned shapes.
 */
function guideFor(
  axis: 'x' | 'y',
  position: number,
  moving: Bounds,
  targets: readonly Bounds[],
  along: (b: Bounds) => [number, number],
  across: (b: Bounds) => [number, number]
): SnapGuide {
  const [mAcrossLo, mAcrossHi] = across(moving);
  let start = mAcrossLo;
  let end = mAcrossHi;
  for (const t of targets) {
    const [lo, hi] = along(t);
    // Any of this target's low/centre/high lines coincident with the guide.
    if (Math.abs(lo - position) < 1e-6 || Math.abs(hi - position) < 1e-6 || Math.abs((lo + hi) / 2 - position) < 1e-6) {
      const [aLo, aHi] = across(t);
      start = Math.min(start, aLo);
      end = Math.max(end, aHi);
    }
  }
  return { axis, position, start, end };
}
