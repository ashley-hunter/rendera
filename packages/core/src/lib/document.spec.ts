import {
  DOCUMENT_SCHEMA_VERSION,
  SceneDocument,
  type SerializedDocument,
} from './document';
import { asNodeId, createSequentialIdFactory } from './id';
import type { GroupNode, LayerNode } from './node';

function newDoc(): SceneDocument {
  return SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
}

function layer(doc: SceneDocument, name: string, parentId = doc.root.id) {
  return doc.insert<LayerNode>({ type: 'layer', name }, { parentId });
}

describe('SceneDocument.create', () => {
  it('starts with a single document root', () => {
    const doc = newDoc();
    expect(doc.size).toBe(1);
    expect(doc.root.type).toBe('document');
    expect(doc.root.parentId).toBeNull();
    expect(doc.getParent(doc.root.id)).toBeUndefined();
  });
});

describe('insert', () => {
  it('appends children in insertion order by default', () => {
    const doc = newDoc();
    const a = layer(doc, 'a');
    const b = layer(doc, 'b');
    const c = layer(doc, 'c');
    expect(doc.getChildren(doc.root.id).map((n) => n.id)).toEqual([a.id, b.id, c.id]);
  });

  it('honours first / before / after positions', () => {
    const doc = newDoc();
    const a = layer(doc, 'a');
    const c = layer(doc, 'c');
    const first = doc.insert<LayerNode>(
      { type: 'layer', name: 'first' },
      { position: { at: 'first' } }
    );
    const b = doc.insert<LayerNode>(
      { type: 'layer', name: 'b' },
      { position: { at: 'after', id: a.id } }
    );
    const beforeC = doc.insert<LayerNode>(
      { type: 'layer', name: 'beforeC' },
      { position: { at: 'before', id: c.id } }
    );
    expect(doc.getChildren(doc.root.id).map((n) => n.id)).toEqual([
      first.id,
      a.id,
      b.id,
      beforeC.id,
      c.id,
    ]);
  });

  it('rejects children under a leaf node', () => {
    const doc = newDoc();
    const leaf = layer(doc, 'leaf');
    expect(() => layer(doc, 'child', leaf.id)).toThrow(/cannot have children/);
  });

  it('nests groups and layers', () => {
    const doc = newDoc();
    const group = doc.insert<GroupNode>({ type: 'group', name: 'g' });
    const child = layer(doc, 'child', group.id);
    expect(doc.getParent(child.id)?.id).toBe(group.id);
    expect(doc.getAncestors(child.id).map((n) => n.id)).toEqual([group.id, doc.root.id]);
  });
});

describe('move', () => {
  it('reparents a node', () => {
    const doc = newDoc();
    const group = doc.insert<GroupNode>({ type: 'group', name: 'g' });
    const l = layer(doc, 'l');
    doc.move(l.id, { parentId: group.id });
    expect(doc.getParent(l.id)?.id).toBe(group.id);
    expect(doc.getChildren(doc.root.id).map((n) => n.id)).toEqual([group.id]);
  });

  it('reorders within the same parent', () => {
    const doc = newDoc();
    const a = layer(doc, 'a');
    const b = layer(doc, 'b');
    const c = layer(doc, 'c');
    doc.move(c.id, { position: { at: 'first' } });
    expect(doc.getChildren(doc.root.id).map((n) => n.id)).toEqual([c.id, a.id, b.id]);
  });

  it('prevents cycles and moving the root', () => {
    const doc = newDoc();
    const a = doc.insert<GroupNode>({ type: 'group', name: 'a' });
    const b = doc.insert<GroupNode>({ type: 'group', name: 'b' }, { parentId: a.id });
    expect(() => doc.move(a.id, { parentId: b.id })).toThrow(/itself or its own descendant/);
    expect(() => doc.move(a.id, { parentId: a.id })).toThrow();
    expect(() => doc.move(doc.root.id)).toThrow(/root/);
  });
});

describe('update', () => {
  it('merges data fields and ignores structural keys', () => {
    const doc = newDoc();
    const l = layer(doc, 'l');
    const updated = doc.update(l.id, {
      name: 'renamed',
      id: 'evil',
      type: 'evil',
      parentId: 'evil',
      index: 'evil',
    });
    expect((updated as LayerNode).name).toBe('renamed');
    expect(updated.id).toBe(l.id);
    expect(updated.type).toBe('layer');
    expect(updated.parentId).toBe(doc.root.id);
  });
});

describe('remove', () => {
  it('removes a node and its whole subtree', () => {
    const doc = newDoc();
    const group = doc.insert<GroupNode>({ type: 'group', name: 'g' });
    const c1 = layer(doc, 'c1', group.id);
    const c2 = layer(doc, 'c2', group.id);
    const removed = doc.remove(group.id);
    expect(new Set(removed)).toEqual(new Set([group.id, c1.id, c2.id]));
    expect(doc.has(group.id)).toBe(false);
    expect(doc.size).toBe(1);
  });

  it('refuses to remove the root', () => {
    const doc = newDoc();
    expect(() => doc.remove(doc.root.id)).toThrow(/root/);
  });
});

describe('serialization', () => {
  it('round-trips through JSON preserving structure and order', () => {
    const doc = newDoc();
    const group = doc.insert<GroupNode>({ type: 'group', name: 'g' });
    layer(doc, 'c1', group.id);
    layer(doc, 'c2', group.id);
    layer(doc, 'top');

    const json = JSON.parse(JSON.stringify(doc.toJSON())) as SerializedDocument;
    const restored = SceneDocument.fromJSON(json);

    expect(restored.size).toBe(doc.size);
    expect(restored.root.id).toBe(doc.root.id);
    expect(restored.getChildren(group.id).map((n) => (n as LayerNode).name)).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('rejects malformed serialized documents', () => {
    const base = newDoc();
    base.insert<GroupNode>({ type: 'group', name: 'g' });
    const good = base.toJSON();

    expect(() =>
      SceneDocument.fromJSON({ ...good, version: DOCUMENT_SCHEMA_VERSION + 1 })
    ).toThrow(/version/);

    const dup: SerializedDocument = {
      version: DOCUMENT_SCHEMA_VERSION,
      nodes: [...good.nodes, { ...good.nodes[1] }],
    };
    expect(() => SceneDocument.fromJSON(dup)).toThrow(/duplicate/);

    const twoRoots: SerializedDocument = {
      version: DOCUMENT_SCHEMA_VERSION,
      nodes: good.nodes.map((n) => ({ ...n, parentId: null })),
    };
    expect(() => SceneDocument.fromJSON(twoRoots)).toThrow(/more than one root/);

    const missingParent: SerializedDocument = {
      version: DOCUMENT_SCHEMA_VERSION,
      nodes: [
        good.nodes[0],
        { ...good.nodes[1], parentId: asNodeId('ghost') },
      ],
    };
    expect(() => SceneDocument.fromJSON(missingParent)).toThrow(/missing parent/);
  });

  it('detects parent cycles in serialized input', () => {
    const doc = newDoc();
    const a = doc.insert<GroupNode>({ type: 'group', name: 'a' });
    const b = doc.insert<GroupNode>({ type: 'group', name: 'b' }, { parentId: a.id });
    const json = doc.toJSON();
    const cyclic: SerializedDocument = {
      version: DOCUMENT_SCHEMA_VERSION,
      nodes: json.nodes.map((n) =>
        n.id === a.id ? { ...n, parentId: b.id } : n
      ),
    };
    expect(() => SceneDocument.fromJSON(cyclic)).toThrow(/cycle/);
  });
});
