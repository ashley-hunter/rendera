import { boundsApproxEquals, boundsFromRect } from './bounds';
import {
  createCamera,
  DEFAULT_CAMERA,
  fitBounds,
  panBy,
  rotateAround,
  screenToWorld,
  visibleWorldBounds,
  worldToScreen,
  zoomAround,
} from './camera';
import { approxEquals as vecApproxEquals, vec2 } from './vec2';

describe('createCamera', () => {
  it('defaults to identity', () => {
    expect(createCamera()).toEqual(DEFAULT_CAMERA);
    expect(DEFAULT_CAMERA).toEqual({ pan: vec2(0, 0), zoom: 1, rotation: 0 });
  });
});

describe('coordinate conversions', () => {
  it('maps world to screen as pan + zoom*R*world', () => {
    const cam = createCamera({ pan: vec2(100, 50), zoom: 2 });
    expect(worldToScreen(cam, vec2(10, 10))).toEqual(vec2(120, 70));
  });

  it('applies rotation (y-down quarter turn)', () => {
    const cam = createCamera({ rotation: Math.PI / 2 });
    expect(vecApproxEquals(worldToScreen(cam, vec2(1, 0)), vec2(0, 1))).toBe(true);
  });

  it('round-trips screen <-> world', () => {
    const cam = createCamera({ pan: vec2(30, -12), zoom: 1.75, rotation: 0.6 });
    const p = vec2(9, -4);
    expect(vecApproxEquals(screenToWorld(cam, worldToScreen(cam, p)), p)).toBe(true);
  });
});

describe('visibleWorldBounds', () => {
  it('is the viewport rect in world space', () => {
    const viewport = { width: 200, height: 100 };
    expect(
      boundsApproxEquals(
        visibleWorldBounds(DEFAULT_CAMERA, viewport),
        boundsFromRect(0, 0, 200, 100)
      )
    ).toBe(true);
    expect(
      boundsApproxEquals(
        visibleWorldBounds(createCamera({ zoom: 2 }), viewport),
        boundsFromRect(0, 0, 100, 50)
      )
    ).toBe(true);
  });
});

describe('panBy', () => {
  it('shifts the pan by a screen delta', () => {
    const cam = createCamera({ pan: vec2(10, 20), zoom: 3 });
    expect(panBy(cam, vec2(5, -5))).toEqual({ pan: vec2(15, 15), zoom: 3, rotation: 0 });
  });
});

describe('zoomAround', () => {
  it('keeps the anchored world point fixed on screen', () => {
    const cam = createCamera({ pan: vec2(40, 10), zoom: 1.5, rotation: 0.3 });
    const anchor = vec2(120, 80);
    const worldUnder = screenToWorld(cam, anchor);
    const zoomed = zoomAround(cam, anchor, 2);
    expect(zoomed.zoom).toBeCloseTo(3, 9);
    expect(vecApproxEquals(worldToScreen(zoomed, worldUnder), anchor)).toBe(true);
  });
});

describe('rotateAround', () => {
  it('keeps the anchored world point fixed while rotating', () => {
    const cam = createCamera({ pan: vec2(5, 5), zoom: 2 });
    const anchor = vec2(100, 100);
    const worldUnder = screenToWorld(cam, anchor);
    const rotated = rotateAround(cam, anchor, Math.PI / 3);
    expect(rotated.rotation).toBeCloseTo(Math.PI / 3, 9);
    expect(vecApproxEquals(worldToScreen(rotated, worldUnder), anchor)).toBe(true);
  });
});

describe('fitBounds', () => {
  it('centers the bounds in the viewport at the limiting zoom', () => {
    const cam = fitBounds(boundsFromRect(0, 0, 100, 50), { width: 200, height: 200 });
    expect(cam.zoom).toBeCloseTo(2, 9); // width-limited: 200/100
    expect(cam.rotation).toBe(0);
    // The bounds' corners map inside and are centered.
    expect(vecApproxEquals(worldToScreen(cam, vec2(0, 0)), vec2(0, 50))).toBe(true);
    expect(vecApproxEquals(worldToScreen(cam, vec2(100, 50)), vec2(200, 150))).toBe(true);
  });
});
