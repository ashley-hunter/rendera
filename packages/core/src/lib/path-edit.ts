/**
 * Path point editing — enumerate a path's on-curve anchors and off-curve control
 * points, and move any one of them, as pure functions over a `Path` (DOM-free,
 * unit-tested). The editor projects these local-space points to screen for its
 * point handles, and calls `setPathPoint` as the user drags one.
 */

import type { Path, PathSegment, SubPath } from './path';
import type { Vec2 } from './vec2';

/** Identifies a single editable point within a path. */
export type PathPointRef =
  | { readonly sub: number; readonly kind: 'start' }
  | { readonly sub: number; readonly seg: number; readonly kind: 'to' | 'control' | 'c1' | 'c2' };

/** An editable point: its reference, position (path-local), and anchor-ness. */
export interface PathPoint {
  readonly ref: PathPointRef;
  readonly point: Vec2;
  /** True for an on-curve anchor, false for an off-curve control handle. */
  readonly anchor: boolean;
}

/** Every editable point of `path`, in draw order. */
export function pathPoints(path: Path): PathPoint[] {
  const out: PathPoint[] = [];
  path.subpaths.forEach((sp, sub) => {
    out.push({ ref: { sub, kind: 'start' }, point: sp.start, anchor: true });
    sp.segments.forEach((seg, seg_) => {
      if (seg.type === 'quad') out.push({ ref: { sub, seg: seg_, kind: 'control' }, point: seg.control, anchor: false });
      if (seg.type === 'cubic') {
        out.push({ ref: { sub, seg: seg_, kind: 'c1' }, point: seg.c1, anchor: false });
        out.push({ ref: { sub, seg: seg_, kind: 'c2' }, point: seg.c2, anchor: false });
      }
      out.push({ ref: { sub, seg: seg_, kind: 'to' }, point: seg.to, anchor: true });
    });
  });
  return out;
}

/**
 * The control-handle guide lines (anchor → control) for drawing the path's
 * off-curve handles: a quad control links to both its endpoints; a cubic's `c1`
 * links to the segment's start anchor and `c2` to its end anchor.
 */
export function pathHandleLines(path: Path): { from: Vec2; to: Vec2 }[] {
  const lines: { from: Vec2; to: Vec2 }[] = [];
  for (const sp of path.subpaths) {
    sp.segments.forEach((seg, s) => {
      const prev = s === 0 ? sp.start : sp.segments[s - 1].to;
      if (seg.type === 'quad') {
        lines.push({ from: prev, to: seg.control });
        lines.push({ from: seg.to, to: seg.control });
      } else if (seg.type === 'cubic') {
        lines.push({ from: prev, to: seg.c1 });
        lines.push({ from: seg.to, to: seg.c2 });
      }
    });
  }
  return lines;
}

function movedSegment(seg: PathSegment, ref: Extract<PathPointRef, { seg: number }>, p: Vec2): PathSegment {
  switch (ref.kind) {
    case 'to': return { ...seg, to: p };
    case 'control': return seg.type === 'quad' ? { ...seg, control: p } : seg;
    case 'c1': return seg.type === 'cubic' ? { ...seg, c1: p } : seg;
    case 'c2': return seg.type === 'cubic' ? { ...seg, c2: p } : seg;
  }
}

/** Return a new path with the point at `ref` moved to `p` (path-local space). */
export function setPathPoint(path: Path, ref: PathPointRef, p: Vec2): Path {
  const subpaths: SubPath[] = path.subpaths.map((sp, sub) => {
    if (sub !== ref.sub) return sp;
    if (ref.kind === 'start') return { ...sp, start: p };
    return { ...sp, segments: sp.segments.map((seg, s) => (s === ref.seg ? movedSegment(seg, ref, p) : seg)) };
  });
  return { subpaths };
}
