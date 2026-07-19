/**
 * Platform-agnostic pointer input.
 *
 * `PointerInput` is a DOM-free, normalized pointer event (mouse/pen/touch). The
 * UI layer (e.g. `@rendera/angular`) translates browser `PointerEvent`s into it,
 * and tests/tools can synthesize it. Coordinates are in the surface's screen
 * space (logical px); world coordinates are derived through the camera, so the
 * event itself stays camera-independent.
 */

import { screenToWorld, type Camera } from './camera';
import type { Vec2 } from './vec2';

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

export interface PointerModifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export interface PointerInput {
  readonly phase: PointerPhase;
  readonly pointerId: number;
  readonly pointerType: 'mouse' | 'pen' | 'touch';
  /** Position in the surface's screen space (logical px, surface-relative). */
  readonly screen: Vec2;
  /** Pressed-button bitmask (DOM `buttons` semantics). */
  readonly buttons: number;
  readonly modifiers: PointerModifiers;
  /** Pen/stylus pressure in [0, 1] (1 for a pressed mouse button). */
  readonly pressure: number;
  /** Pen tilt in degrees, or 0 when unavailable. */
  readonly tiltX: number;
  readonly tiltY: number;
  /** High-frequency intermediate sample positions (for smooth strokes). */
  readonly coalesced: readonly Vec2[];
}

/** Whether the additive-selection modifier (shift or ctrl) is held. */
export function isAdditive(modifiers: PointerModifiers): boolean {
  return modifiers.shift || modifiers.ctrl;
}

/** The pointer's position in world space, given a camera. */
export function pointerToWorld(input: PointerInput, camera: Camera): Vec2 {
  return screenToWorld(camera, input.screen);
}
