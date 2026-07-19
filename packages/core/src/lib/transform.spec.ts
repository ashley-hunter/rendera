import { approxEquals as matApproxEquals, IDENTITY, transformPoint } from './matrix';
import { createTransform, IDENTITY_TRANSFORM, toMatrix } from './transform';
import { approxEquals as vecApproxEquals, vec2 } from './vec2';

describe('createTransform', () => {
  it('fills identity defaults', () => {
    const t = createTransform();
    expect(t).toEqual(IDENTITY_TRANSFORM);
    expect(t.scale).toEqual(vec2(1, 1));
  });

  it('overrides only the provided channels', () => {
    const t = createTransform({ rotation: 1, translation: vec2(2, 3) });
    expect(t.rotation).toBe(1);
    expect(t.translation).toEqual(vec2(2, 3));
    expect(t.scale).toEqual(vec2(1, 1));
  });
});

describe('toMatrix', () => {
  it('maps the identity transform to the identity matrix', () => {
    expect(matApproxEquals(toMatrix(IDENTITY_TRANSFORM), IDENTITY)).toBe(true);
  });

  it('applies scale then translation (pivot at origin)', () => {
    const t = createTransform({ translation: vec2(10, 0), scale: vec2(2, 2) });
    expect(transformPoint(toMatrix(t), vec2(1, 1))).toEqual(vec2(12, 2));
  });

  it('keeps the pivot fixed at the translation under rotation', () => {
    const t = createTransform({
      translation: vec2(100, 50),
      rotation: 0.9,
      scale: vec2(3, 2),
      pivot: vec2(7, 4),
    });
    // Whatever the rotation/scale, the pivot point maps to the translation.
    expect(
      vecApproxEquals(transformPoint(toMatrix(t), vec2(7, 4)), vec2(100, 50))
    ).toBe(true);
  });
});
