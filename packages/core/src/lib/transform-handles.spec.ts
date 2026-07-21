import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import type { GroupNode, PathNode } from './node';
import { rectPath } from './path';
import { applyTransform, dragTransform, handles, selectionFrame } from './transform-handles';
import { vec2 } from './vec2';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
const tf = (tx: number, ty: number) => ({
  transform: { translation: { x: tx, y: ty }, rotation: 0, scale: { x: 1, y: 1 }, skew: 0, pivot: { x: 0, y: 0 } },
});
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

describe('selectionFrame & handles', () => {
  it('frames a single node in world space, oriented with it', () => {
    const d = doc();
    const n = d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 80, 60), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    d.update(n.id, tf(10, 20));
    const box = selectionFrame(d, [n.id])!;
    const hs = handles(box);
    const at = (id: string) => hs.find((h) => h.id === id)!.point;
    expect(at('nw')).toEqual({ x: 10, y: 20 });
    expect(at('se')).toEqual({ x: 90, y: 80 });
    expect(at('n')).toEqual({ x: 50, y: 20 });
    // Rotate grip sits above the top-centre.
    expect(at('rotate').y).toBeLessThan(20);
    expect(at('rotate').x).toBe(50);
  });
});

describe('dragTransform + applyTransform', () => {
  const boxNode = () => {
    const d = doc();
    const n = d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 80, 60), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    d.update(n.id, tf(10, 20)); // world bounds (10,20)-(90,80)
    return { d, id: n.id };
  };

  it('move translates the node', () => {
    const { d, id } = boxNode();
    const box = selectionFrame(d, [id])!;
    applyTransform(d, [id], dragTransform(box, 'move', vec2(50, 50), vec2(70, 90)));
    const b = d.getWorldBounds(id)!;
    expect(b).toEqual({ minX: 30, minY: 60, maxX: 110, maxY: 120 });
  });

  it('resizing the SE handle scales about the NW corner', () => {
    const { d, id } = boxNode();
    const box = selectionFrame(d, [id])!;
    // Drag SE from (90,80) out to (130,80): x grows 1.5x, y unchanged; NW fixed.
    applyTransform(d, [id], dragTransform(box, 'se', vec2(90, 80), vec2(130, 80)));
    const b = d.getWorldBounds(id)!;
    expect(near(b.minX, 10) && near(b.minY, 20)).toBe(true); // NW held
    expect(near(b.maxX, 130)).toBe(true); // width 80 → 120
    expect(near(b.maxY, 80)).toBe(true); // height unchanged
  });

  it('uniform corner resize keeps aspect ratio', () => {
    const { d, id } = boxNode();
    const box = selectionFrame(d, [id])!;
    applyTransform(d, [id], dragTransform(box, 'se', vec2(90, 80), vec2(130, 80), { uniform: true }));
    const b = d.getWorldBounds(id)!;
    // Both axes scale 1.5x about NW: width 80→120, height 60→90.
    expect(near(b.maxX, 130)).toBe(true);
    expect(near(b.maxY, 110)).toBe(true);
  });

  it('rotating 90° swaps the bounding box dimensions about the centre', () => {
    const d = doc();
    const n = d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(-40, -30, 80, 60), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } });
    // centred at the origin; world bounds (-40,-30)-(40,30)
    const box = selectionFrame(d, [n.id])!;
    // Drag the rotate grip from straight-up to straight-right → +90°.
    applyTransform(d, [n.id], dragTransform(box, 'rotate', vec2(0, -50), vec2(50, 0)));
    const b = d.getWorldBounds(n.id)!;
    expect(near(b.maxX - b.minX, 60)).toBe(true); // 80-wide box now 60 wide
    expect(near(b.maxY - b.minY, 80)).toBe(true);
    expect(near((b.minX + b.maxX) / 2, 0) && near((b.minY + b.maxY) / 2, 0)).toBe(true);
  });

  it('applies the world delta through a parent transform', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'g' });
    d.update(g.id, tf(100, 0));
    const n = d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 10, 10), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } }, { parentId: g.id });
    // world bounds (100,0)-(110,10)
    const box = selectionFrame(d, [n.id])!;
    applyTransform(d, [n.id], dragTransform(box, 'move', vec2(105, 5), vec2(110, 5))); // world +5 x
    const b = d.getWorldBounds(n.id)!;
    expect(near(b.minX, 105) && near(b.maxX, 115)).toBe(true);
    // The child's LOCAL translation absorbed the delta (parent is at x=100).
    const child = d.get(n.id) as PathNode;
    expect(near(child.transform.translation.x, 5)).toBe(true);
  });
});
