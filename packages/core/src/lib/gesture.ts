/**
 * Multi-touch viewport gesture recognizer (DOM-free).
 *
 * Fed normalized screen positions keyed by pointer id, it turns one- or
 * two-plus-finger drags into a pan (+ pinch zoom) that the UI layer applies to
 * its camera via `panBy` / `zoomAround`. It is a small stateful recognizer — it
 * tracks the live pointer set — but knows nothing about the DOM or the camera,
 * so it is fully unit-testable and shared by every surface (Canvas2D, WebGPU).
 *
 * Model: the gesture is summarised each move by the pointers' **centroid** and
 * their mean **spread** (average distance from that centroid). Centroid motion
 * is the pan; the ratio of spreads is the pinch zoom, anchored at the centroid.
 * Adding or lifting a finger silently re-baselines, so the view never jumps
 * when the pointer count changes mid-gesture.
 */

import { subtract, vec2, ZERO, type Vec2 } from './vec2';

/** A camera change produced by a viewport gesture, in screen space. */
export interface ViewportGestureChange {
  /** Screen-space pan delta (how far the pointer centroid moved). */
  readonly pan: Vec2;
  /** Multiplicative zoom about `anchor`; 1 when fewer than two pointers. */
  readonly zoom: number;
  /** Screen-space anchor for the zoom (the current pointer centroid). */
  readonly anchor: Vec2;
}

export class ViewportGesture {
  private readonly pointers = new Map<number, Vec2>();
  private centroid: Vec2 = ZERO;
  private spread = 0;

  /** Number of pointers currently down. */
  get activeCount(): number {
    return this.pointers.size;
  }

  /** Register a new pointer and re-baseline (no change emitted). */
  down(id: number, screen: Vec2): void {
    this.pointers.set(id, screen);
    this.rebase();
  }

  /**
   * Update a tracked pointer's position, returning the camera change since the
   * previous sample, or `null` if the pointer is not being tracked.
   */
  move(id: number, screen: Vec2): ViewportGestureChange | null {
    if (!this.pointers.has(id)) {
      return null;
    }
    this.pointers.set(id, screen);
    const prevCentroid = this.centroid;
    const prevSpread = this.spread;
    this.rebase();
    const pan = subtract(this.centroid, prevCentroid);
    const zoom =
      prevSpread > 0 && this.spread > 0 ? this.spread / prevSpread : 1;
    return { pan, zoom, anchor: this.centroid };
  }

  /** Remove a pointer (up/cancel) and re-baseline the remaining set. */
  up(id: number): void {
    this.pointers.delete(id);
    this.rebase();
  }

  /** Forget every pointer (e.g. when the surface loses all captures). */
  clear(): void {
    this.pointers.clear();
    this.centroid = ZERO;
    this.spread = 0;
  }

  /** Recompute the centroid and mean spread from the live pointer set. */
  private rebase(): void {
    const points = [...this.pointers.values()];
    if (points.length === 0) {
      this.centroid = ZERO;
      this.spread = 0;
      return;
    }
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    this.centroid = vec2(sx / points.length, sy / points.length);

    // A single pointer has no spread, so it can only pan, never zoom.
    if (points.length < 2) {
      this.spread = 0;
      return;
    }
    let total = 0;
    for (const p of points) {
      total += Math.hypot(p.x - this.centroid.x, p.y - this.centroid.y);
    }
    this.spread = total / points.length;
  }
}
