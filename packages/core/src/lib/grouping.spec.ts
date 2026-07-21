import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import { groupNodes, makeBoolean, ungroupNodes } from './grouping';
import type { GroupNode, PathNode } from './node';
import { rectPath } from './path';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
const tf = (tx: number, ty: number, s = 1) => ({
  transform: { translation: { x: tx, y: ty }, rotation: 0, scale: { x: s, y: s }, skew: 0, pivot: { x: 0, y: 0 } },
});
const rect = (d: SceneDocument, tx: number, ty: number, parentId?: string) =>
  d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 20, 20), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, ...tf(tx, ty) }, parentId ? { parentId } : {});
const wb = (d: SceneDocument, id: string) => d.getWorldBounds(id)!;

describe('groupNodes', () => {
  it('wraps the selection in a group, preserving world position', () => {
    const d = doc();
    const a = rect(d, 10, 10);
    const b = rect(d, 100, 60);
    const beforeA = wb(d, a.id);
    const beforeB = wb(d, b.id);

    const gid = groupNodes(d, [a.id, b.id])!;
    expect(gid).toBeDefined();
    expect(d.get(gid)!.type).toBe('group');
    // Both nodes now live under the group…
    expect(d.get(a.id)!.parentId).toBe(gid);
    expect(d.get(b.id)!.parentId).toBe(gid);
    // …and haven't moved on screen.
    expect(wb(d, a.id)).toEqual(beforeA);
    expect(wb(d, b.id)).toEqual(beforeB);
  });

  it('is one undo step and returns null for an empty selection', () => {
    const d = doc();
    let sets = 0;
    d.subscribe(() => sets++);
    expect(groupNodes(d, [])).toBeNull();
    expect(sets).toBe(0);
    rect(d, 0, 0);
    sets = 0;
    groupNodes(d, [d.getChildren(d.root.id)[0].id]);
    expect(sets).toBe(1);
  });
});

describe('ungroupNodes', () => {
  it('lifts children out of a transformed group, preserving world position', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'g', ...tf(50, 20, 2) });
    const child = rect(d, 5, 5, g.id); // world = (50 + 5*2 ..) = 60..100
    const before = wb(d, child.id);

    const freed = ungroupNodes(d, [g.id]);

    expect(freed).toEqual([child.id]);
    expect(d.has(g.id)).toBe(false); // group removed
    expect(d.get(child.id)!.parentId).toBe(d.root.id);
    // The group's 2x scale + offset baked into the child → unchanged on screen.
    expect(wb(d, child.id).minX).toBeCloseTo(before.minX);
    expect(wb(d, child.id).minY).toBeCloseTo(before.minY);
    expect(wb(d, child.id).maxX).toBeCloseTo(before.maxX);
  });

  it('ignores non-group ids', () => {
    const d = doc();
    const r = rect(d, 0, 0);
    expect(ungroupNodes(d, [r.id])).toEqual([]);
    expect(d.has(r.id)).toBe(true);
  });

  it('round-trips: group then ungroup restores world positions', () => {
    const d = doc();
    const a = rect(d, 10, 10);
    const b = rect(d, 90, 40);
    const beforeA = wb(d, a.id);
    const gid = groupNodes(d, [a.id, b.id])!;
    // Move the group, then ungroup — children keep the moved-into-world position.
    d.update(gid, tf(25, 25));
    const movedA = wb(d, a.id);
    expect(movedA.minX).toBeCloseTo(beforeA.minX + 25);
    ungroupNodes(d, [gid]);
    expect(wb(d, a.id).minX).toBeCloseTo(movedA.minX);
  });
});

describe('makeBoolean', () => {
  it('combines path operands into a boolean node under the op', () => {
    const d = doc();
    const a = rect(d, 0, 0);
    const b = rect(d, 10, 10);
    const before = wb(d, a.id);
    const id = makeBoolean(d, [a.id, b.id], 'union')!;
    expect(id).toBeDefined();
    const node = d.get(id) as { type: string; op: string };
    expect(node.type).toBe('boolean');
    expect(node.op).toBe('union');
    expect(d.get(a.id)!.parentId).toBe(id);
    expect(wb(d, a.id)).toEqual(before); // world-preserved
  });

  it('needs two combinable operands', () => {
    const d = doc();
    const a = rect(d, 0, 0);
    const g = d.insert<GroupNode>({ type: 'group', name: 'g', ...tf(0, 0) });
    // One path + one group → only one valid operand.
    expect(makeBoolean(d, [a.id, g.id], 'intersect')).toBeNull();
  });
});
