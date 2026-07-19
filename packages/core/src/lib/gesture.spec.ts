import {
  createCamera,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAround,
  type Camera,
} from './camera';
import { ViewportGesture } from './gesture';
import { add, approxEquals, vec2 } from './vec2';

/** Apply a recognizer change to a camera the way a UI component would. */
function applyChange(
  camera: Camera,
  change: { pan: { x: number; y: number }; zoom: number; anchor: { x: number; y: number } }
): Camera {
  let next = panBy(camera, change.pan);
  if (change.zoom !== 1) {
    next = zoomAround(next, change.anchor, change.zoom);
  }
  return next;
}

describe('ViewportGesture', () => {
  it('reports the number of active pointers', () => {
    const g = new ViewportGesture();
    expect(g.activeCount).toBe(0);
    g.down(1, vec2(0, 0));
    g.down(2, vec2(10, 0));
    expect(g.activeCount).toBe(2);
    g.up(1);
    expect(g.activeCount).toBe(1);
  });

  it('returns null for a pointer it is not tracking', () => {
    const g = new ViewportGesture();
    expect(g.move(99, vec2(1, 1))).toBeNull();
  });

  it('maps a single-pointer drag to a pure pan (no zoom)', () => {
    const g = new ViewportGesture();
    g.down(1, vec2(100, 100));
    const change = g.move(1, vec2(130, 90));
    expect(change).not.toBeNull();
    if (!change) return;
    expect(approxEquals(change.pan, vec2(30, -10))).toBe(true);
    expect(change.zoom).toBe(1);
  });

  it('does not jump when a second finger is added mid-gesture', () => {
    const g = new ViewportGesture();
    g.down(1, vec2(100, 100));
    // Adding a finger re-baselines silently: the next move is measured from
    // the new two-finger centroid, not treated as a leap.
    g.down(2, vec2(200, 100));
    const change = g.move(2, vec2(200, 100)); // no actual movement
    expect(change).not.toBeNull();
    if (!change) return;
    expect(approxEquals(change.pan, vec2(0, 0))).toBe(true);
    expect(change.zoom).toBe(1);
  });

  it('produces a net >1 zoom about the centroid when two fingers spread apart', () => {
    // Pointer events fire one finger at a time, so pan/zoom fluctuate per event;
    // the meaningful quantity is the cumulative effect across both moves.
    const g = new ViewportGesture();
    g.down(1, vec2(100, 100));
    g.down(2, vec2(200, 100)); // centroid (150,100), spread from centroid = 50
    // Symmetric spread to double the gap: 50 -> 100 (each finger moves out 50).
    const c1 = g.move(1, vec2(50, 100));
    const c2 = g.move(2, vec2(250, 100));
    if (!c1 || !c2) throw new Error('expected changes');
    // Cumulative zoom ~ 2x (spread 50 -> 100); centroid unchanged -> no net pan.
    expect(c1.zoom * c2.zoom).toBeCloseTo(2, 6);
    expect(approxEquals(add(c1.pan, c2.pan), vec2(0, 0), 1e-6)).toBe(true);
  });

  it('produces a <1 zoom when two fingers pinch together', () => {
    const g = new ViewportGesture();
    g.down(1, vec2(50, 100));
    g.down(2, vec2(250, 100));
    g.move(1, vec2(100, 100));
    const change = g.move(2, vec2(200, 100));
    expect(change).not.toBeNull();
    if (!change) return;
    expect(change.zoom).toBeLessThan(1);
  });

  it('pinch keeps the world point under the centroid fixed when applied to a camera', () => {
    const g = new ViewportGesture();
    let camera = createCamera({ pan: vec2(10, 20), zoom: 1.5 });

    g.down(1, vec2(120, 140));
    g.down(2, vec2(220, 140)); // centroid (170,140)
    const centroid = vec2(170, 140);
    const worldBefore = screenToWorld(camera, centroid);

    // Spread the fingers; apply every emitted change to the camera.
    const c1 = g.move(1, vec2(80, 140));
    if (c1) camera = applyChange(camera, c1);
    const c2 = g.move(2, vec2(260, 140));
    if (c2) camera = applyChange(camera, c2);

    // The world point under the (unchanged) centroid must not have moved.
    const worldAfter = screenToWorld(camera, centroid);
    expect(approxEquals(worldBefore, worldAfter, 1e-6)).toBe(true);
    // And it zoomed in.
    expect(camera.zoom).toBeGreaterThan(1.5);
    // The same world point still projects back to the centroid.
    expect(approxEquals(worldToScreen(camera, worldBefore), centroid, 1e-6)).toBe(true);
  });

  it('two-finger translation pans without net zoom', () => {
    const g = new ViewportGesture();
    g.down(1, vec2(100, 100));
    g.down(2, vec2(200, 100));
    // Both fingers move right by 40: centroid shifts +40x, spread unchanged.
    const c1 = g.move(1, vec2(140, 100));
    const c2 = g.move(2, vec2(240, 100));
    if (!c1 || !c2) throw new Error('expected changes');
    // Net pan +40x, and the spread returns to its start so cumulative zoom ~ 1.
    expect(approxEquals(add(c1.pan, c2.pan), vec2(40, 0), 1e-6)).toBe(true);
    expect(c1.zoom * c2.zoom).toBeCloseTo(1, 6);
  });

  it('re-baselines when a finger lifts so the remaining finger keeps panning smoothly', () => {
    const g = new ViewportGesture();
    g.down(1, vec2(100, 100));
    g.down(2, vec2(200, 100));
    g.up(2); // lift the second finger; centroid re-bases to finger 1 (100,100)
    const change = g.move(1, vec2(120, 100));
    expect(change).not.toBeNull();
    if (!change) return;
    expect(approxEquals(change.pan, vec2(20, 0))).toBe(true);
    expect(change.zoom).toBe(1);
  });

  it('clear() drops all pointers', () => {
    const g = new ViewportGesture();
    g.down(1, vec2(0, 0));
    g.down(2, vec2(10, 10));
    g.clear();
    expect(g.activeCount).toBe(0);
    expect(g.move(1, vec2(5, 5))).toBeNull();
  });
});
