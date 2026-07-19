import {
  approxEquals,
  compose,
  determinant,
  fromRotation,
  fromScaling,
  fromSkew,
  fromTranslation,
  IDENTITY,
  invert,
  mat2d,
  multiply,
  transformPoint,
  transformVector,
} from './matrix';
import { approxEquals as vecApproxEquals, vec2 } from './vec2';

describe('matrix constructors', () => {
  it('builds identity, translation and scaling', () => {
    expect(transformPoint(IDENTITY, vec2(3, 7))).toEqual(vec2(3, 7));
    expect(transformPoint(fromTranslation(vec2(2, 5)), vec2(1, 1))).toEqual(vec2(3, 6));
    expect(transformPoint(fromScaling(vec2(2, 3)), vec2(4, 5))).toEqual(vec2(8, 15));
  });

  it('rotates the +x axis toward +y (y-down, quarter turn)', () => {
    const r = fromRotation(Math.PI / 2);
    expect(vecApproxEquals(transformPoint(r, vec2(1, 0)), vec2(0, 1))).toBe(true);
  });

  it('skews x by y', () => {
    const s = fromSkew(Math.PI / 4, 0);
    expect(vecApproxEquals(transformPoint(s, vec2(0, 1)), vec2(1, 1))).toBe(true);
  });
});

describe('matrix composition', () => {
  it('multiply applies the right-hand matrix first', () => {
    const m = multiply(fromTranslation(vec2(10, 0)), fromScaling(vec2(2, 2)));
    // scale (1,1) -> (2,2) then translate -> (12, 2)
    expect(transformPoint(m, vec2(1, 1))).toEqual(vec2(12, 2));
  });

  it('compose folds left-to-right, applying the last matrix first', () => {
    const m = compose(fromTranslation(vec2(10, 0)), fromScaling(vec2(2, 2)));
    expect(transformPoint(m, vec2(1, 1))).toEqual(vec2(12, 2));
    expect(approxEquals(compose(), IDENTITY)).toBe(true);
  });

  it('transformVector ignores translation', () => {
    const m = multiply(fromTranslation(vec2(10, 20)), fromScaling(vec2(2, 2)));
    expect(transformVector(m, vec2(1, 1))).toEqual(vec2(2, 2));
  });
});

describe('matrix inversion', () => {
  it('round-trips a point through a composed transform', () => {
    const m = compose(
      fromTranslation(vec2(5, -3)),
      fromRotation(0.7),
      fromScaling(vec2(2, 4))
    );
    const inv = invert(m);
    expect(inv).not.toBeNull();
    if (!inv) {
      return;
    }
    const p = vec2(9, -2);
    expect(vecApproxEquals(transformPoint(inv, transformPoint(m, p)), p)).toBe(true);
  });

  it('reports determinant and returns null for singular matrices', () => {
    expect(determinant(fromScaling(vec2(2, 3)))).toBe(6);
    expect(invert(mat2d(0, 0, 0, 0, 1, 1))).toBeNull();
  });
});
