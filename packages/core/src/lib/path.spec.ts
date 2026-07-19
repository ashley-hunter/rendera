import { boundsApproxEquals, boundsFromRect } from './bounds';
import { fromScaling } from './matrix';
import {
  ellipsePath,
  flattenPath,
  pathBounds,
  pathEdges,
  pointInPath,
  polygonPath,
  rectPath,
  roundedRectPath,
  toQuadraticPath,
  transformPath,
} from './path';
import { vec2 } from './vec2';

describe('path primitives', () => {
  it('rect is a closed 3-segment subpath with the right bounds', () => {
    const p = rectPath(10, 20, 100, 50);
    expect(p.subpaths).toHaveLength(1);
    expect(p.subpaths[0].closed).toBe(true);
    expect(p.subpaths[0].segments).toHaveLength(3);
    expect(boundsApproxEquals(pathBounds(p)!, boundsFromRect(10, 20, 100, 50))).toBe(true);
  });

  it('ellipse is four cubics with the right bounds', () => {
    const p = ellipsePath(50, 50, 40, 30);
    expect(p.subpaths[0].segments).toHaveLength(4);
    expect(p.subpaths[0].segments.every((s) => s.type === 'cubic')).toBe(true);
    expect(boundsApproxEquals(pathBounds(p)!, boundsFromRect(10, 20, 80, 60))).toBe(true);
  });

  it('rounded rect clamps radius and stays within bounds', () => {
    const p = roundedRectPath(0, 0, 100, 40, 1000);
    // Radius clamps to 20 (half the short side); bounds unchanged.
    expect(boundsApproxEquals(pathBounds(p)!, boundsFromRect(0, 0, 100, 40))).toBe(true);
  });

  it('polygon closes through its points', () => {
    const p = polygonPath([vec2(0, 0), vec2(10, 0), vec2(5, 10)]);
    expect(p.subpaths[0].segments).toHaveLength(2); // start + 2 lines, auto-closed
    expect(p.subpaths[0].closed).toBe(true);
  });
});

describe('toQuadraticPath', () => {
  it('replaces cubics with quadratics that track the curve', () => {
    const q = toQuadraticPath(ellipsePath(0, 0, 50, 50), 0.05);
    expect(q.subpaths[0].segments.every((s) => s.type === 'quad')).toBe(true);
    // The flattened quad approximation stays near the true circle radius.
    for (const poly of flattenPath(q, 0.05)) {
      for (const pt of poly) {
        expect(Math.abs(Math.hypot(pt.x, pt.y) - 50)).toBeLessThan(0.5);
      }
    }
  });

  it('leaves lines untouched', () => {
    const q = toQuadraticPath(rectPath(0, 0, 10, 10));
    expect(q.subpaths[0].segments.every((s) => s.type === 'line')).toBe(true);
  });
});

describe('pathEdges', () => {
  it('emits one edge per segment plus a closing edge', () => {
    const edges = pathEdges(rectPath(0, 0, 10, 10));
    expect(edges).toHaveLength(4); // 3 line segments + 1 close
    expect(edges.every((e) => !e.quad)).toBe(true);
  });

  it('marks quadratic edges', () => {
    const edges = pathEdges(toQuadraticPath(ellipsePath(0, 0, 5, 5)));
    expect(edges.some((e) => e.quad)).toBe(true);
  });
});

describe('pointInPath', () => {
  it('tests inside vs outside a rectangle', () => {
    const p = rectPath(0, 0, 100, 100);
    expect(pointInPath(p, vec2(50, 50))).toBe(true);
    expect(pointInPath(p, vec2(150, 50))).toBe(false);
  });

  it('honours the even-odd rule for a hole (concentric squares)', () => {
    const outer = rectPath(0, 0, 100, 100).subpaths[0];
    const inner = rectPath(25, 25, 50, 50).subpaths[0];
    const donut = { subpaths: [outer, inner] };
    // Centre is inside both squares -> even winding -> a hole under even-odd.
    expect(pointInPath(donut, vec2(50, 50), 'evenodd')).toBe(false);
    // Between the squares -> inside one -> filled.
    expect(pointInPath(donut, vec2(10, 50), 'evenodd')).toBe(true);
  });

  it('is inside an ellipse at the centre, outside past the radius', () => {
    const p = ellipsePath(0, 0, 40, 30);
    expect(pointInPath(p, vec2(0, 0))).toBe(true);
    expect(pointInPath(p, vec2(39, 0))).toBe(true);
    expect(pointInPath(p, vec2(41, 0))).toBe(false);
    expect(pointInPath(p, vec2(0, 31))).toBe(false);
  });
});

describe('transformPath', () => {
  it('scales all points', () => {
    const p = transformPath(rectPath(0, 0, 10, 10), fromScaling(vec2(2, 3)));
    expect(boundsApproxEquals(pathBounds(p)!, boundsFromRect(0, 0, 20, 30))).toBe(true);
  });
});
