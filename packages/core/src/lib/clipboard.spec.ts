import { clipboardHasContent, copyNodes, pasteNodes } from './clipboard';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import type { GroupNode, PathNode } from './node';
import { rectPath } from './path';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
const tf = (tx: number, ty: number) => ({
  transform: { translation: { x: tx, y: ty }, rotation: 0, scale: { x: 1, y: 1 }, skew: 0, pivot: { x: 0, y: 0 } },
});
const rect = (d: SceneDocument, tx: number, ty: number, parentId?: string) =>
  d.insert<PathNode>({ type: 'path', name: 'r', path: rectPath(0, 0, 20, 20), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, ...tf(tx, ty) }, parentId ? { parentId } : {});

describe('copyNodes / pasteNodes', () => {
  it('pastes a fresh copy with new ids, offset from the original', () => {
    const d = doc();
    const a = rect(d, 10, 20);
    const clip = copyNodes(d, [a.id]);

    const before = d.size;
    const [pastedId] = pasteNodes(d, clip, { dx: 10, dy: 10 });

    expect(pastedId).not.toBe(a.id);
    expect(d.size).toBe(before + 1);
    const pasted = d.get(pastedId) as PathNode;
    expect(pasted.transform.translation).toEqual({ x: 20, y: 30 }); // offset
    expect(pasted.path).toEqual((d.get(a.id) as PathNode).path); // same geometry
  });

  it('deep-copies a subtree (group + children get fresh ids)', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'g', ...tf(0, 0) });
    const child = rect(d, 5, 5, g.id);
    const clip = copyNodes(d, [g.id]);

    const [pastedGroup] = pasteNodes(d, clip);
    const kids = d.getChildren(pastedGroup);
    expect(pastedGroup).not.toBe(g.id);
    expect(kids).toHaveLength(1);
    expect(kids[0].id).not.toBe(child.id);
    expect((kids[0] as PathNode).path).toEqual((d.get(child.id) as PathNode).path);
  });

  it('snapshots — later edits to the original do not change the clipboard', () => {
    const d = doc();
    const a = rect(d, 0, 0);
    const clip = copyNodes(d, [a.id]);
    d.remove(a.id); // original gone
    // The snapshot still pastes fine.
    const [pastedId] = pasteNodes(d, clip);
    expect(d.get(pastedId)!.type).toBe('path');
  });

  it('pastes into a given parent and can paste twice independently', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'g', ...tf(0, 0) });
    const a = rect(d, 0, 0);
    const clip = copyNodes(d, [a.id]);
    const [p1] = pasteNodes(d, clip, { parentId: g.id });
    const [p2] = pasteNodes(d, clip, { parentId: g.id });
    expect(d.get(p1)!.parentId).toBe(g.id);
    expect(d.get(p2)!.parentId).toBe(g.id);
    expect(p1).not.toBe(p2);
  });

  it('dedupes nested selection and reports content', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'g', ...tf(0, 0) });
    const child = rect(d, 0, 0, g.id);
    const clip = copyNodes(d, [g.id, child.id]); // child folds into the group
    expect(clip.nodes).toHaveLength(1);
    expect(clipboardHasContent(clip)).toBe(true);
    expect(clipboardHasContent({ nodes: [] })).toBe(false);
    expect(clipboardHasContent(null)).toBe(false);
  });

  it('is one undo step per paste', () => {
    const d = doc();
    const a = rect(d, 0, 0);
    const b = rect(d, 40, 0);
    const clip = copyNodes(d, [a.id, b.id]);
    let sets = 0;
    d.subscribe(() => sets++);
    pasteNodes(d, clip);
    expect(sets).toBe(1);
  });
});
