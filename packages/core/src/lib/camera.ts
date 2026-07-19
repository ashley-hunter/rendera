/**
 * Camera — the per-viewer world <-> screen transform (ADR 0004).
 *
 * The camera is a pure value: pan, zoom, and rotation, anchored to the world
 * origin. `pan` is where the world origin lands on screen (logical px), so
 *
 *     worldToScreen(p) = pan + zoom · R(rotation) · p
 *
 * It is intentionally viewport-independent — the viewport size is passed only
 * to the operations that need it (visible bounds, fit). The camera lives in
 * viewport state, never in the document, so it never pollutes undo or sync.
 * Device-pixel-ratio is a backend concern and is not modelled here.
 */

import {
  boundsFromRect,
  transformBounds,
  type Bounds,
  boundsCenter,
  boundsHeight,
  boundsWidth,
} from './bounds';
import {
  compose,
  fromRotation,
  fromScaling,
  fromTranslation,
  invert,
  type Mat2D,
  transformPoint,
  transformVector,
} from './matrix';
import { add, scale, subtract, type Vec2, vec2, ZERO } from './vec2';

export interface Camera {
  /** Screen position (logical px) of the world origin. */
  readonly pan: Vec2;
  /** Scale factor (1 = 100%). */
  readonly zoom: number;
  /** Rotation in radians (y-down: turns +x toward +y). */
  readonly rotation: number;
}

/** The size of the drawing surface in logical pixels. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_CAMERA: Camera = { pan: ZERO, zoom: 1, rotation: 0 };

/** Build a camera, defaulting any omitted channel to identity. */
export function createCamera(partial: Partial<Camera> = {}): Camera {
  return {
    pan: partial.pan ?? ZERO,
    zoom: partial.zoom ?? 1,
    rotation: partial.rotation ?? 0,
  };
}

/** The world-to-screen matrix `T(pan) · S(zoom) · R(rotation)`. */
export function worldToScreenMatrix(camera: Camera): Mat2D {
  return compose(
    fromTranslation(camera.pan),
    fromScaling(vec2(camera.zoom, camera.zoom)),
    fromRotation(camera.rotation)
  );
}

/** The inverse (screen-to-world) matrix. */
export function screenToWorldMatrix(camera: Camera): Mat2D {
  const inverse = invert(worldToScreenMatrix(camera));
  if (!inverse) {
    // zoom is required to be non-zero; guard defensively.
    throw new Error('camera is not invertible (zoom must be non-zero)');
  }
  return inverse;
}

export function worldToScreen(camera: Camera, world: Vec2): Vec2 {
  return transformPoint(worldToScreenMatrix(camera), world);
}

export function screenToWorld(camera: Camera, screen: Vec2): Vec2 {
  return transformPoint(screenToWorldMatrix(camera), screen);
}

/** The world-space axis-aligned bounds currently visible in the viewport. */
export function visibleWorldBounds(camera: Camera, viewport: Viewport): Bounds {
  return transformBounds(
    screenToWorldMatrix(camera),
    boundsFromRect(0, 0, viewport.width, viewport.height)
  );
}

/** Translate the view by a screen-space delta. */
export function panBy(camera: Camera, screenDelta: Vec2): Camera {
  return { ...camera, pan: add(camera.pan, screenDelta) };
}

/**
 * A camera whose screen output is uniformly scaled by `pixelRatio`, i.e. one
 * that maps world → *device* pixels instead of logical (CSS) pixels:
 * `worldToScreen(withPixelRatio(cam, k), p) === k · worldToScreen(cam, p)`.
 *
 * DPR is deliberately not part of `Camera` (ADR 0004) — the camera stays in
 * logical space for input and hit-testing, and the backend derives the device
 * camera at the render seam so it can rasterize at full physical resolution.
 */
export function withPixelRatio(camera: Camera, pixelRatio: number): Camera {
  return {
    pan: scale(camera.pan, pixelRatio),
    zoom: camera.zoom * pixelRatio,
    rotation: camera.rotation,
  };
}

/** The pan that places `world` at `screen` for a given zoom and rotation. */
function panToAlign(
  zoom: number,
  rotation: number,
  world: Vec2,
  screen: Vec2
): Vec2 {
  const linear = compose(fromScaling(vec2(zoom, zoom)), fromRotation(rotation));
  return subtract(screen, transformVector(linear, world));
}

/** Multiply zoom by `factor`, keeping the world point under `screenAnchor` fixed. */
export function zoomAround(
  camera: Camera,
  screenAnchor: Vec2,
  factor: number
): Camera {
  const worldUnder = screenToWorld(camera, screenAnchor);
  const zoom = camera.zoom * factor;
  return {
    pan: panToAlign(zoom, camera.rotation, worldUnder, screenAnchor),
    zoom,
    rotation: camera.rotation,
  };
}

/** Rotate by `deltaRadians`, keeping the world point under `screenAnchor` fixed. */
export function rotateAround(
  camera: Camera,
  screenAnchor: Vec2,
  deltaRadians: number
): Camera {
  const worldUnder = screenToWorld(camera, screenAnchor);
  const rotation = camera.rotation + deltaRadians;
  return {
    pan: panToAlign(camera.zoom, rotation, worldUnder, screenAnchor),
    zoom: camera.zoom,
    rotation,
  };
}

/**
 * A camera (rotation 0) that fits `worldBounds` centered in the viewport, with
 * optional uniform screen-space `padding`.
 */
export function fitBounds(
  worldBounds: Bounds,
  viewport: Viewport,
  padding = 0
): Camera {
  const availW = viewport.width - 2 * padding;
  const availH = viewport.height - 2 * padding;
  const bw = boundsWidth(worldBounds);
  const bh = boundsHeight(worldBounds);
  const zx = bw > 0 ? availW / bw : Infinity;
  const zy = bh > 0 ? availH / bh : Infinity;
  let zoom = Math.min(zx, zy);
  if (!Number.isFinite(zoom) || zoom <= 0) {
    zoom = 1;
  }
  const worldCenter = boundsCenter(worldBounds);
  const screenCenter = vec2(viewport.width / 2, viewport.height / 2);
  return {
    pan: panToAlign(zoom, 0, worldCenter, screenCenter),
    zoom,
    rotation: 0,
  };
}

export function cameraApproxEquals(a: Camera, b: Camera, epsilon = 1e-9): boolean {
  return (
    Math.abs(a.pan.x - b.pan.x) <= epsilon &&
    Math.abs(a.pan.y - b.pan.y) <= epsilon &&
    Math.abs(a.zoom - b.zoom) <= epsilon &&
    Math.abs(a.rotation - b.rotation) <= epsilon
  );
}
