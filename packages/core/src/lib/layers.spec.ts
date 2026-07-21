import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import { layerRows, moveNode } from './layers';
import type { GroupNode, PathNode } from './node';
import { rectPath } from './path';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
const tf = () => ({ transform: { translation: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, skew: 0, pivot: { x: 0, y: 0 } } });
const rect = (d: SceneDocument, name: string, parentId?: string) =>
  d.insert<PathNode>({ type: 'path', name, path: rectPath(0, 0, 10, 10), fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, ...tf() }, parentId ? { parentId } : {});
const group = (d: SceneDocument, name: string, parentId?: string) =>
  d.insert<GroupNode>({ type: 'group', name, ...tf() }, parentId ? { parentId } : {});

describe('layerRows', () => {
  it('flattens the tree front-to-back with depth, name, and child info', () => {
    const d = doc();
    const back = rect(d, 'back');
    const g = group(d, 'grp');
    const inner = rect(d, 'inner', g.id);

    const rows = layerRows(d);
    // Front-most (highest index) first: the group is inserted after `back`.
    expect(rows.map((r) => r.name)).toEqual(['grp', 'inner', 'back']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0]);
    const grpRow = rows.find((r) => r.id === g.id)!;
    expect(grpRow.container).toBe(true);
    expect(grpRow.hasChildren).toBe(true);
    const backRow = rows.find((r) => r.id === back.id)!;
    expect(backRow.container).toBe(false);
    expect(backRow.visible).toBe(true);
  });

  it('hides a collapsed container’s subtree but keeps the container row', () => {
    const d = doc();
    const g = group(d, 'grp');
    rect(d, 'inner', g.id);
    const rows = layerRows(d, { collapsed: new Set([g.id]) });
    expect(rows.map((r) => r.name)).toEqual(['grp']);
    expect(rows[0].collapsed).toBe(true);
  });

  it('reports visibility from the node', () => {
    const d = doc();
    const n = rect(d, 'r');
    d.update(n.id, { visible: false });
    expect(layerRows(d)[0].visible).toBe(false);
  });
});

describe('moveNode', () => {
  it('reorders siblings with above/below (z-order)', () => {
    const d = doc();
    const a = rect(d, 'a'); // index low (back)
    const b = rect(d, 'b'); // index high (front)
    // Move a ABOVE b → a becomes front-most.
    expect(moveNode(d, a.id, b.id, 'above')).toBe(true);
    expect(layerRows(d).map((r) => r.name)).toEqual(['a', 'b']);
    // Move a BELOW b → back to a behind b.
    moveNode(d, a.id, b.id, 'below');
    expect(layerRows(d).map((r) => r.name)).toEqual(['b', 'a']);
  });

  it('reparents a node inside a container', () => {
    const d = doc();
    const g = group(d, 'grp');
    const r = rect(d, 'r');
    expect(moveNode(d, r.id, g.id, 'inside')).toBe(true);
    expect(d.get(r.id)!.parentId).toBe(g.id);
    expect(d.getChildren(g.id).map((c) => c.id)).toContain(r.id);
  });

  it('rejects illegal moves (into a leaf, into own descendant, onto self)', () => {
    const d = doc();
    const g = group(d, 'grp');
    const inner = rect(d, 'inner', g.id);
    const leaf = rect(d, 'leaf');

    expect(moveNode(d, leaf.id, inner.id, 'inside')).toBe(false); // leaf isn't a container
    expect(moveNode(d, g.id, inner.id, 'inside')).toBe(false); // into own descendant
    expect(moveNode(d, g.id, g.id, 'above')).toBe(false); // onto self
    // The tree is unchanged.
    expect(d.get(inner.id)!.parentId).toBe(g.id);
    expect(d.get(g.id)!.parentId).toBe(d.root.id);
  });
});
