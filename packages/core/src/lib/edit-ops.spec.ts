import { SceneDocument } from './document';
import { deleteNodes, duplicateNodes, nudgeNodes } from './edit-ops';
import { createSequentialIdFactory } from './id';
import type { GroupNode, PathNode } from './node';
import { rectPath } from './path';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
const tf = (tx: number, ty: number) => ({
  transform: { translation: { x: tx, y: ty }, rotation: 0, scale: { x: 1, y: 1 }, skew: 0, pivot: { x: 0, y: 0 } },
});
const rect = (d: SceneDocument, tx: number, ty: number, parentId?: string) =>
  d.insert<PathNode>(
    { type: 'path', name: 'r', path: rectPath(0, 0, 40, 30), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, ...tf(tx, ty) },
    parentId ? { parentId } : {}
  );

describe('deleteNodes', () => {
  it('removes a node and its whole subtree in one undo step', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'g', ...tf(0, 0) });
    const child = rect(d, 5, 5, g.id);
    const keep = rect(d, 100, 100);
    let sets = 0;
    d.subscribe(() => sets++);

    deleteNodes(d, [g.id]);

    expect(d.has(g.id)).toBe(false);
    expect(d.has(child.id)).toBe(false);
    expect(d.has(keep.id)).toBe(true);
    expect(sets).toBe(1); // one change-set → one undo entry
  });

  it('is a no-op for an already-removed / missing id', () => {
    const d = doc();
    expect(() => deleteNodes(d, ['nope'])).not.toThrow();
  });
});

describe('duplicateNodes', () => {
  it('deep-clones a subtree as a sibling with fresh ids and an offset', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'g', ...tf(10, 10) });
    const child = rect(d, 5, 5, g.id);

    const [copyId] = duplicateNodes(d, [g.id], 10, 20);

    expect(copyId).toBeDefined();
    expect(copyId).not.toBe(g.id);
    // Same parent (sibling of the original).
    expect(d.get(copyId)!.parentId).toBe(d.root.id);
    // Offset applied to the copy's translation only.
    const copy = d.get(copyId) as GroupNode;
    expect(copy.transform.translation).toEqual({ x: 20, y: 30 });
    expect((d.get(g.id) as GroupNode).transform.translation).toEqual({ x: 10, y: 10 });
    // Child was cloned with a fresh id under the copy.
    const copyChildren = d.getChildren(copyId);
    expect(copyChildren).toHaveLength(1);
    expect(copyChildren[0].id).not.toBe(child.id);
    expect((copyChildren[0] as PathNode).path).toEqual((d.get(child.id) as PathNode).path);
  });

  it('dedupes a nested selection (skips ids whose ancestor is also selected)', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'g', ...tf(0, 0) });
    const child = rect(d, 5, 5, g.id);
    const before = d.size;

    const copies = duplicateNodes(d, [g.id, child.id]);

    // Only the group root is duplicated (group + its one child = +2 nodes).
    expect(copies).toHaveLength(1);
    expect(d.size).toBe(before + 2);
  });

  it('lands as a single undo step', () => {
    const d = doc();
    const a = rect(d, 0, 0);
    const b = rect(d, 50, 0);
    let sets = 0;
    d.subscribe(() => sets++);
    duplicateNodes(d, [a.id, b.id]);
    expect(sets).toBe(1);
  });
});

describe('nudgeNodes', () => {
  it('translates the selection by a world delta', () => {
    const d = doc();
    const n = rect(d, 10, 20);
    nudgeNodes(d, [n.id], 4, -6);
    const b = d.getWorldBounds(n.id)!;
    expect(b.minX).toBeCloseTo(14);
    expect(b.minY).toBeCloseTo(14);
  });

  it('is a single undo step and a no-op for an empty selection', () => {
    const d = doc();
    const n = rect(d, 0, 0);
    let sets = 0;
    d.subscribe(() => sets++);
    nudgeNodes(d, [], 5, 5);
    expect(sets).toBe(0);
    nudgeNodes(d, [n.id], 5, 5);
    expect(sets).toBe(1);
  });
});
