import type { Bounds } from './bounds';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import type { PathNode } from './node';
import { rectPath } from './path';
import { snapMove } from './snapping';
import { vec2 } from './vec2';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
const tf = (tx: number, ty: number) => ({
  transform: { translation: { x: tx, y: ty }, rotation: 0, scale: { x: 1, y: 1 }, skew: 0, pivot: { x: 0, y: 0 } },
});
// A 40x30 rect at world (tx,ty)-(tx+40,ty+30).
const rect = (d: SceneDocument, tx: number, ty: number) =>
  d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 40, 30), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, ...tf(tx, ty) });
const box = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({ minX, minY, maxX, maxY });

describe('snapMove', () => {
  it('snaps the left edge to a neighbour a few px away, emitting a vertical guide', () => {
    const d = doc();
    const moving = rect(d, 0, 0); // (0,0)-(40,30)
    rect(d, 100, 200); // static target at (100,200)-(140,230)
    const mBounds = d.getWorldBounds(moving.id)!;

    // Propose moving so the left edge lands at x=97 — 3px shy of the target's left (100).
    const res = snapMove(d, [moving.id], mBounds, vec2(97, 200), { threshold: 6 });

    expect(res.delta.x).toBeCloseTo(100); // pulled the 3px to align left edges
    expect(res.delta.y).toBeCloseTo(200); // y already aligned exactly (no change)
    const gx = res.guides.find((g) => g.axis === 'x')!;
    expect(gx.position).toBeCloseTo(100);
    // Spans both boxes vertically.
    expect(gx.start).toBeCloseTo(200);
    expect(gx.end).toBeCloseTo(230);
  });

  it('leaves the delta untouched and emits no guides when nothing is in range', () => {
    const d = doc();
    const moving = rect(d, 0, 0);
    rect(d, 500, 500);
    const mBounds = d.getWorldBounds(moving.id)!;
    const res = snapMove(d, [moving.id], mBounds, vec2(10, 10), { threshold: 6 });
    expect(res.delta).toEqual({ x: 10, y: 10 });
    expect(res.guides).toHaveLength(0);
  });

  it('snaps centres when edges are out of range', () => {
    const d = doc();
    const moving = rect(d, 0, 0); // 40 wide, centre 20px from its left
    // A wide target (150..250) whose centre is 200 but whose edges are far away,
    // so only the centre line is within range.
    const res = snapMove(d, [moving.id], d.getWorldBounds(moving.id)!, vec2(179, 0), { threshold: 6, targets: [box(150, 0, 250, 30)] });
    // Moving centre after dx=179 is 20+179=199 → pull +1 to 200 (target centre).
    expect(res.delta.x).toBeCloseTo(180);
    expect(res.guides.find((g) => g.axis === 'x')!.position).toBeCloseTo(200);
  });

  it('picks the closest of competing snap lines', () => {
    const d = doc();
    const moving = rect(d, 0, 0);
    // Two targets: left edge at 105 (moving-left dist 5) and 102 (dist 2).
    const res = snapMove(d, [moving.id], d.getWorldBounds(moving.id)!, vec2(100, 0), {
      threshold: 8,
      centers: false,
      targets: [box(105, 0, 145, 30), box(102, 0, 142, 30)],
    });
    expect(res.delta.x).toBeCloseTo(102); // closer target wins
  });

  it('is a no-op with no moving bounds', () => {
    const d = doc();
    const res = snapMove(d, [], null, vec2(5, 5), { threshold: 6 });
    expect(res).toEqual({ delta: { x: 5, y: 5 }, guides: [] });
  });

  it('snaps the box edge to the grid when no shape wins', () => {
    const d = doc();
    const moving = rect(d, 0, 0); // box 0..40; grid 25
    const res = snapMove(d, [moving.id], d.getWorldBounds(moving.id)!, vec2(23, 11), { threshold: 6, grid: 25, targets: [] });
    // box.minX after dx=23 is 23 → nearest 25-line is 25 (adjust +2).
    expect(res.delta.x).toBeCloseTo(25);
    // box.minY after dy=11 is 11 → nearest 25-line is 0 (adjust -11 → 0).
    expect(res.delta.y).toBeCloseTo(0);
    expect(res.guides).toHaveLength(0); // the grid draws itself
  });

  it('lets a shape snap override the grid on that axis', () => {
    const d = doc();
    const moving = rect(d, 0, 0);
    // Target left edge at 24 (2px from box.minX after dx=22); grid 25 would pull to 25.
    const res = snapMove(d, [moving.id], d.getWorldBounds(moving.id)!, vec2(22, 0), {
      threshold: 6, grid: 25, centers: false, targets: [box(24, 0, 64, 20)],
    });
    expect(res.delta.x).toBeCloseTo(24); // shape (24) beats grid (25)
    expect(res.guides.find((g) => g.axis === 'x')!.position).toBeCloseTo(24);
  });
});
