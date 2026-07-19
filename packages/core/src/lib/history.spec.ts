import { SceneDocument } from './document';
import { History } from './history';
import { createSequentialIdFactory } from './id';
import type { GroupNode, LayerNode } from './node';

function setup(options?: { limit?: number }) {
  const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
  const history = new History(doc, options);
  const layer = (name: string, parentId = doc.root.id) =>
    doc.insert<LayerNode>({ type: 'layer', name }, { parentId });
  const group = (name: string, parentId = doc.root.id) =>
    doc.insert<GroupNode>({ type: 'group', name }, { parentId });
  return { doc, history, layer, group };
}

describe('History insert/undo/redo', () => {
  it('undoes and redoes an insert', () => {
    const { doc, history, layer } = setup();
    const l = layer('a');
    expect(history.canUndo).toBe(true);
    expect(doc.has(l.id)).toBe(true);

    expect(history.undo()).toBe(true);
    expect(doc.has(l.id)).toBe(false);
    expect(doc.size).toBe(1);
    expect(history.canRedo).toBe(true);

    expect(history.redo()).toBe(true);
    expect(doc.has(l.id)).toBe(true);
    expect((doc.require(l.id) as LayerNode).name).toBe('a');
  });

  it('returns false when there is nothing to undo/redo', () => {
    const { history } = setup();
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
  });
});

describe('History update', () => {
  it('reverts and reapplies field changes', () => {
    const { doc, history, layer } = setup();
    const l = layer('before');
    doc.update(l.id, { name: 'after' });
    expect((doc.require(l.id) as LayerNode).name).toBe('after');

    history.undo();
    expect((doc.require(l.id) as LayerNode).name).toBe('before');
    history.redo();
    expect((doc.require(l.id) as LayerNode).name).toBe('after');
  });
});

describe('History move', () => {
  it('restores the previous parent on undo', () => {
    const { doc, history, group, layer } = setup();
    const g = group('g');
    const l = layer('l');
    doc.move(l.id, { parentId: g.id });
    expect(doc.getParent(l.id)?.id).toBe(g.id);

    history.undo();
    expect(doc.getParent(l.id)?.id).toBe(doc.root.id);
    history.redo();
    expect(doc.getParent(l.id)?.id).toBe(g.id);
  });
});

describe('History remove', () => {
  it('restores a whole subtree on undo', () => {
    const { doc, history, group, layer } = setup();
    const g = group('g');
    const c1 = layer('c1', g.id);
    const c2 = layer('c2', g.id);

    doc.remove(g.id);
    expect(doc.size).toBe(1);

    history.undo();
    expect(doc.has(g.id)).toBe(true);
    expect(doc.getChildren(g.id).map((n) => n.id)).toEqual([c1.id, c2.id]);

    history.redo();
    expect(doc.has(g.id)).toBe(false);
    expect(doc.size).toBe(1);
  });
});

describe('History batching and coalescing', () => {
  it('groups a batch into a single undo entry', () => {
    const { doc, history } = setup();
    history.batch(() => {
      doc.insert<LayerNode>({ type: 'layer', name: 'a' });
      doc.insert<LayerNode>({ type: 'layer', name: 'b' });
    });
    expect(history.undoDepth).toBe(1);
    expect(doc.size).toBe(3);

    history.undo();
    expect(doc.size).toBe(1);
  });

  it('coalesces consecutive same-key change-sets', () => {
    const { doc, history, layer } = setup();
    const l = layer('start');
    expect(history.undoDepth).toBe(1); // the insert

    doc.transaction(() => doc.update(l.id, { name: 'step1' }), {
      coalesceKey: 'rename',
    });
    doc.transaction(() => doc.update(l.id, { name: 'step2' }), {
      coalesceKey: 'rename',
    });
    expect(history.undoDepth).toBe(2); // insert + one coalesced rename

    history.undo(); // reverts both renames at once
    expect((doc.require(l.id) as LayerNode).name).toBe('start');
  });
});

describe('History redo invalidation and limits', () => {
  it('clears redo on a fresh edit', () => {
    const { history, layer } = setup();
    layer('a');
    history.undo();
    expect(history.canRedo).toBe(true);
    layer('b');
    expect(history.canRedo).toBe(false);
  });

  it('drops the oldest entries beyond the limit', () => {
    const { history, layer } = setup({ limit: 2 });
    layer('a');
    layer('b');
    layer('c');
    expect(history.undoDepth).toBe(2);
  });
});

describe('History.withoutHistory', () => {
  it('does not record changes made inside it', () => {
    const { doc, history } = setup();
    history.withoutHistory(() => {
      doc.insert<LayerNode>({ type: 'layer', name: 'ephemeral' });
    });
    expect(doc.size).toBe(2);
    expect(history.canUndo).toBe(false);
  });
});
