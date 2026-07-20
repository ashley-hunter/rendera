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

/**
 * Decompose an arbitrary affine matrix into a pivot-free `Transform` such that
 * `toMatrix(matrixToTransform(m))` reproduces `m`. The linear part factors as
 * `R(θ)·K(skew)·S(scale)` (the same order `toMatrix` composes), so translation
 * is the matrix's `(e, f)`, `θ = atan2(b, a)`, `scale.x = |(a, b)|`, and the
 * shear/`scale.y` fall out of the rotation-removed second column. A reflection
 * (negative determinant) lands in a negative `scale.y`. This is how SVG's baked
 * `matrix(...)`/composed transform lists become node transforms.
 */
export function matrixToTransform(m: Mat2D): Transform {
  const sx = Math.hypot(m.a, m.b);
  const rotation = Math.atan2(m.b, m.a);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // Second column with the rotation rotated out: [c', d'] = R(-θ)·[c, d].
  const cPrime = cos * m.c + sin * m.d;
  const dPrime = -sin * m.c + cos * m.d;
  return {
    translation: vec2(m.e, m.f),
    rotation,
    // tan(skew) = c'/d'; atan2 keeps that ratio exact through `fromSkew`.
    skew: Math.atan2(cPrime, dPrime),
    scale: vec2(sx, dPrime),
    pivot: ZERO,
  };
}
