import { alignNodes, distributeNodes } from './align';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import type { PathNode } from './node';
import { rectPath } from './path';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
const tf = (tx: number, ty: number) => ({
  transform: { translation: { x: tx, y: ty }, rotation: 0, scale: { x: 1, y: 1 }, skew: 0, pivot: { x: 0, y: 0 } },
});
// A `w`x`h` rect placed at world (tx,ty).
const rect = (d: SceneDocument, tx: number, ty: number, w = 20, h = 20) =>
  d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, w, h), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, ...tf(tx, ty) });
const world = (d: SceneDocument, id: string) => d.getWorldBounds(id)!;

describe('alignNodes', () => {
  it('aligns all left edges to the selection’s left', () => {
    const d = doc();
    const a = rect(d, 0, 0); // left 0
    const b = rect(d, 50, 30); // left 50
    const c = rect(d, 120, 60); // left 120
    alignNodes(d, [a.id, b.id, c.id], 'left');
    expect(world(d, a.id).minX).toBeCloseTo(0);
    expect(world(d, b.id).minX).toBeCloseTo(0);
    expect(world(d, c.id).minX).toBeCloseTo(0);
    // Vertical positions are untouched.
    expect(world(d, b.id).minY).toBeCloseTo(30);
  });

  it('centres horizontally on the selection mid-line', () => {
    const d = doc();
    const a = rect(d, 0, 0, 20, 20); // centre x = 10
    const b = rect(d, 80, 0, 40, 20); // centre x = 100
    // Selection spans x 0..120 → mid-line 60.
    alignNodes(d, [a.id, b.id], 'hcenter');
    expect((world(d, a.id).minX + world(d, a.id).maxX) / 2).toBeCloseTo(60);
    expect((world(d, b.id).minX + world(d, b.id).maxX) / 2).toBeCloseTo(60);
  });

  it('aligns bottom edges', () => {
    const d = doc();
    const a = rect(d, 0, 0, 20, 20); // bottom 20
    const b = rect(d, 0, 40, 20, 30); // bottom 70
    alignNodes(d, [a.id, b.id], 'bottom');
    expect(world(d, a.id).maxY).toBeCloseTo(70);
    expect(world(d, b.id).maxY).toBeCloseTo(70);
  });

  it('is a no-op for fewer than two nodes', () => {
    const d = doc();
    const a = rect(d, 5, 5);
    let sets = 0;
    d.subscribe(() => sets++);
    alignNodes(d, [a.id], 'left');
    expect(sets).toBe(0);
    expect(world(d, a.id).minX).toBeCloseTo(5);
  });
});

describe('distributeNodes', () => {
  it('evenly spaces centres horizontally, holding the extremes', () => {
    const d = doc();
    const a = rect(d, 0, 0, 20, 20); // centre 10
    const mid = rect(d, 30, 0, 20, 20); // centre 40 (will move)
    const c = rect(d, 200, 0, 20, 20); // centre 210
    distributeNodes(d, [a.id, mid.id, c.id], 'horizontal');
    // Extremes fixed; middle centre halfway between 10 and 210 → 110.
    expect((world(d, a.id).minX + world(d, a.id).maxX) / 2).toBeCloseTo(10);
    expect((world(d, c.id).minX + world(d, c.id).maxX) / 2).toBeCloseTo(210);
    expect((world(d, mid.id).minX + world(d, mid.id).maxX) / 2).toBeCloseTo(110);
  });

  it('sorts by position before distributing (input order irrelevant)', () => {
    const d = doc();
    const a = rect(d, 0, 0, 20, 20); // centre 10
    const c = rect(d, 200, 0, 20, 20); // centre 210
    const mid = rect(d, 30, 0, 20, 20); // centre 40
    // Pass out of order — should still land the physical middle at 110.
    distributeNodes(d, [c.id, a.id, mid.id], 'horizontal');
    expect((world(d, mid.id).minX + world(d, mid.id).maxX) / 2).toBeCloseTo(110);
  });

  it('is a no-op for fewer than three nodes', () => {
    const d = doc();
    const a = rect(d, 0, 0);
    const b = rect(d, 100, 0);
    let sets = 0;
    d.subscribe(() => sets++);
    distributeNodes(d, [a.id, b.id], 'horizontal');
    expect(sets).toBe(0);
  });
});
