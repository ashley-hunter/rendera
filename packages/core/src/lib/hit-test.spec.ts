import { SceneDocument } from './document';
import { hitTest, nodesInBox, selectionBounds } from './hit-test';
import { createSequentialIdFactory } from './id';
import type { GroupNode, PathNode } from './node';
import { ellipsePath, rectPath } from './path';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
const tf = (tx: number, ty: number, s = 1) => ({
  transform: { translation: { x: tx, y: ty }, rotation: 0, scale: { x: s, y: s }, skew: 0, pivot: { x: 0, y: 0 } },
});

describe('hitTest', () => {
  it('returns the top-most node under the point (z-order)', () => {
    const d = doc();
    const back = d.insert<PathNode>({ type: 'path', name: 'back', path: rectPath(0, 0, 100, 100), fill: { type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } } });
    const front = d.insert<PathNode>({ type: 'path', name: 'front', path: rectPath(20, 20, 40, 40), fill: { type: 'solid', color: { r: 0, g: 1, b: 0, a: 1 } } });
    expect(hitTest(d, { x: 40, y: 40 })).toBe(front.id); // overlap → later-drawn wins
    expect(hitTest(d, { x: 10, y: 10 })).toBe(back.id); // only the back covers here
    expect(hitTest(d, { x: 200, y: 200 })).toBeNull(); // empty space
  });

  it('respects the node transform', () => {
    const d = doc();
    const n = d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 10, 10), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    d.update(n.id, tf(100, 50, 2)); // moved to (100,50), scaled 2x → covers [100,120]x[50,70]
    expect(hitTest(d, { x: 110, y: 60 })).toBe(n.id);
    expect(hitTest(d, { x: 5, y: 5 })).toBeNull(); // the untransformed location is now empty
  });

  it('honours the fill rule (even-odd hole is not hit)', () => {
    const d = doc();
    const donut = d.insert<PathNode>({
      type: 'path',
      name: 'donut',
      path: { subpaths: [rectPath(0, 0, 100, 100).subpaths[0], rectPath(40, 40, 20, 20).subpaths[0]] },
      fillRule: 'evenodd',
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
    });
    expect(hitTest(d, { x: 10, y: 50 })).toBe(donut.id); // solid ring
    expect(hitTest(d, { x: 50, y: 50 })).toBeNull(); // the even-odd hole
  });

  it('hits a stroke-only path near its edge within tolerance', () => {
    const d = doc();
    const n = d.insert<PathNode>({
      type: 'path',
      name: 'line',
      path: { subpaths: [{ start: { x: 0, y: 0 }, closed: false, segments: [{ type: 'line', to: { x: 100, y: 0 } }] }] },
      stroke: { paint: { type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }, width: 6 },
    });
    expect(hitTest(d, { x: 50, y: 2 })).toBe(n.id); // within half-width (3) of the line
    expect(hitTest(d, { x: 50, y: 10 })).toBeNull(); // beyond the stroke
    expect(hitTest(d, { x: 50, y: 10 }, { tolerance: 8 })).toBe(n.id); // fuzz reaches it
  });

  it('a clip culls hits outside the clip region', () => {
    const d = doc();
    const n = d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 100, 100), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    d.update(n.id, { clip: { path: rectPath(0, 0, 40, 40) } });
    expect(hitTest(d, { x: 20, y: 20 })).toBe(n.id); // inside geometry AND clip
    expect(hitTest(d, { x: 70, y: 70 })).toBeNull(); // inside geometry, outside clip
  });

  it('select "outermost" returns the top-level group', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'grp' });
    const inner = d.insert<GroupNode>({ type: 'group', name: 'inner' }, { parentId: g.id });
    const leaf = d.insert<PathNode>({ type: 'path', name: 'p', path: rectPath(0, 0, 50, 50), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } }, { parentId: inner.id });
    expect(hitTest(d, { x: 25, y: 25 })).toBe(leaf.id);
    expect(hitTest(d, { x: 25, y: 25 }, { select: 'outermost' })).toBe(g.id);
  });

  it('skips hidden nodes', () => {
    const d = doc();
    const n = d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 50, 50), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    d.update(n.id, { visible: false });
    expect(hitTest(d, { x: 25, y: 25 })).toBeNull();
  });
});

describe('selectionBounds', () => {
  it('unions the world bounds of the selected nodes', () => {
    const d = doc();
    const a = d.insert<PathNode>({ type: 'path', name: 'a', path: rectPath(0, 0, 10, 10), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    const b = d.insert<PathNode>({ type: 'path', name: 'b', path: rectPath(0, 0, 10, 10), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    d.update(b.id, tf(90, 40));
    const box = selectionBounds(d, [a.id, b.id])!;
    expect(box).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
    expect(selectionBounds(d, [])).toBeNull();
  });
});

describe('nodesInBox (marquee)', () => {
  const scene = () => {
    const d = doc();
    // Three 20x20 rects at x = 0, 100, 200 (all y 0..20).
    const a = d.insert<PathNode>({ type: 'path', name: 'a', path: rectPath(0, 0, 20, 20), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    const b = d.insert<PathNode>({ type: 'path', name: 'b', path: rectPath(0, 0, 20, 20), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    const c = d.insert<PathNode>({ type: 'path', name: 'c', path: rectPath(0, 0, 20, 20), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    d.update(b.id, tf(100, 0));
    d.update(c.id, tf(200, 0));
    return { d, a: a.id, b: b.id, c: c.id };
  };

  it('picks nodes whose world box touches the marquee (intersect, default)', () => {
    const { d, a, b } = scene();
    // A box from x=10..110 clips into a (0..20) and b (100..120).
    expect(nodesInBox(d, { minX: 10, minY: 0, maxX: 110, maxY: 20 })).toEqual([a, b]);
  });

  it('requires full enclosure with `contained`', () => {
    const { d, b } = scene();
    // The same span only *encloses* b fully (a is clipped, so excluded).
    expect(nodesInBox(d, { minX: 10, minY: -5, maxX: 130, maxY: 25 }, { contained: true })).toEqual([b]);
  });

  it('skips hidden nodes unless asked', () => {
    const { d, a, b } = scene();
    d.update(a, { visible: false });
    const box = { minX: -5, minY: -5, maxX: 125, maxY: 25 };
    expect(nodesInBox(d, box)).toEqual([b]);
    expect(nodesInBox(d, box, { includeHidden: true })).toEqual([a, b]);
  });

  it('returns empty when the marquee hits nothing', () => {
    const { d } = scene();
    expect(nodesInBox(d, { minX: 300, minY: 300, maxX: 400, maxY: 400 })).toEqual([]);
  });
});
