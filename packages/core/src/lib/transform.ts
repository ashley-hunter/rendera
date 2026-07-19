/**
 * Decomposed 2D transforms (TRS + skew).
 *
 * Per ADR 0006, node transforms are authored as separate, animatable channels
 * — translation, rotation, scale, skew, and a pivot — and the affine matrix is
 * *derived* from them. Keeping the channels as the source of truth is what lets
 * a future animation system keyframe rotation and scale independently, which a
 * baked matrix cannot round-trip.
 *
 * The derived matrix is:
 *
 *     M = T(translation) · R(rotation) · K(skew) · S(scale) · T(-pivot)
 *
 * so the `pivot` point (in local space) is the anchor that maps to
 * `translation` in the parent's space, and rotation/scale/skew happen about it.
 */

import { compose, fromRotation, fromScaling, fromSkew, fromTranslation, type Mat2D } from './matrix';
import { negate, type Vec2, vec2, ZERO } from './vec2';

export interface Transform {
  readonly translation: Vec2;
  /** Rotation in radians (y-down: turns +x toward +y). */
  readonly rotation: number;
  readonly scale: Vec2;
  /** Skew (shear) angle in radians, shearing x by y. */
  readonly skew: number;
  /** Local-space anchor about which rotation/scale/skew are applied. */
  readonly pivot: Vec2;
}

/** The identity transform (no translation/rotation/skew, unit scale). */
export const IDENTITY_TRANSFORM: Transform = {
  translation: ZERO,
  rotation: 0,
  scale: vec2(1, 1),
  skew: 0,
  pivot: ZERO,
};

/** Build a transform, defaulting any omitted channels to identity. */
export function createTransform(partial: Partial<Transform> = {}): Transform {
  return {
    translation: partial.translation ?? ZERO,
    rotation: partial.rotation ?? 0,
    scale: partial.scale ?? vec2(1, 1),
    skew: partial.skew ?? 0,
    pivot: partial.pivot ?? ZERO,
  };
}

/** Derive the local-to-parent affine matrix for a transform. */
export function toMatrix(t: Transform): Mat2D {
  return compose(
    fromTranslation(t.translation),
    fromRotation(t.rotation),
    fromSkew(t.skew, 0),
    fromScaling(t.scale),
    fromTranslation(negate(t.pivot))
  );
}
