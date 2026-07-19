import { pathBounds, pointInPath, rectPath, type Path } from './path';
import { strokePath } from './stroke';
import { vec2 } from './vec2';

/** A single open horizontal segment as a path. */
function segment(): Path {
  return { subpaths: [{ start: vec2(20, 50), closed: false, segments: [{ type: 'line', to: vec2(80, 50) }] }] };
}

describe('strokePath', () => {
  it('produces a fillable outline covering the stroke band', () => {
    const outline = strokePath(segment(), { width: 10 });
    // On the centerline: inside. Just outside the half-width: outside.
    expect(pointInPath(outline, vec2(50, 50))).toBe(true);
    expect(pointInPath(outline, vec2(50, 54))).toBe(true); // within +/- 5
    expect(pointInPath(outline, vec2(50, 57))).toBe(false); // beyond 5
  });

  it('butt caps stop at the endpoint; square/round extend past it', () => {
    const butt = strokePath(segment(), { width: 10, cap: 'butt' });
    const square = strokePath(segment(), { width: 10, cap: 'square' });
    const round = strokePath(segment(), { width: 10, cap: 'round' });
    // 3px beyond the x=80 endpoint, on the centerline:
    expect(pointInPath(butt, vec2(83, 50))).toBe(false);
    expect(pointInPath(square, vec2(83, 50))).toBe(true);
    expect(pointInPath(round, vec2(83, 50))).toBe(true);
    // 8px beyond is outside even a round/square cap (half = 5).
    expect(pointInPath(square, vec2(88, 50))).toBe(false);
  });

  it('strokes a closed rectangle into a frame (outer filled, centre hollow)', () => {
    const outline = strokePath(rectPath(20, 20, 60, 60), { width: 8, join: 'miter' });
    // On the rectangle edge: inside the stroke.
    expect(pointInPath(outline, vec2(20, 50))).toBe(true);
    // Well inside the rectangle (away from any edge): not stroked.
    expect(pointInPath(outline, vec2(50, 50))).toBe(false);
    // Outer corner region within the stroke band.
    expect(pointInPath(outline, vec2(20, 20))).toBe(true);
  });

  it('miter join reaches past the corner; bevel does not', () => {
    // Two segments meeting at a right angle at (50,50).
    const elbow: Path = {
      subpaths: [
        { start: vec2(50, 20), closed: false, segments: [{ type: 'line', to: vec2(50, 50) }, { type: 'line', to: vec2(80, 50) }] },
      ],
    };
    const miter = strokePath(elbow, { width: 12, join: 'miter', miterLimit: 4 });
    const bevel = strokePath(elbow, { width: 12, join: 'bevel' });
    // The sharp outer corner (outside both segment rectangles) is filled by the
    // miter but cut away by the bevel.
    const tip = vec2(45, 55);
    expect(pointInPath(miter, tip)).toBe(true);
    expect(pointInPath(bevel, tip)).toBe(false);
  });

  it('is empty for a non-positive width', () => {
    expect(strokePath(segment(), { width: 0 }).subpaths).toHaveLength(0);
    expect(pathBounds(strokePath(segment(), { width: 0 }))).toBeNull();
  });
});
