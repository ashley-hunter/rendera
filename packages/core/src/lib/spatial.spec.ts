import { boundsApproxEquals, boundsFromRect } from './bounds';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import { transformPoint } from './matrix';
import type { GroupNode, LayerNode } from './node';
import { createTransform } from './transform';
import { approxEquals as vecApproxEquals, vec2 } from './vec2';

function newDoc(): SceneDocument {
  return SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
}

describe('world matrix composition', () => {
  it('composes ancestor transforms', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({
      type: 'group',
      name: 'g',
      transform: createTransform({ translation: vec2(100, 50) }),
    });
    const l = doc.insert<LayerNode>(
      {
        type: 'layer',
        name: 'l',
        transform: createTransform({ translation: vec2(10, 10) }),
        size: vec2(20, 20),
      },
      { parentId: g.id }
    );
    const world = doc.getWorldMatrix(l.id);
    // layer origin (0,0) -> +layer(10,10) -> +group(100,50) = (110,60)
    expect(vecApproxEquals(transformPoint(world, vec2(0, 0)), vec2(110, 60))).toBe(true);
  });

  it('gives the root an identity world matrix', () => {
    const doc = newDoc();
    expect(transformPoint(doc.getWorldMatrix(doc.root.id), vec2(3, 4))).toEqual(
      vec2(3, 4)
    );
  });
});

describe('world bounds', () => {
  it('transforms a leaf rect into world space', () => {
    const doc = newDoc();
    const l = doc.insert<LayerNode>({
      type: 'layer',
      name: 'l',
      transform: createTransform({ translation: vec2(110, 60) }),
      size: vec2(20, 20),
    });
    const b = doc.getWorldBounds(l.id);
    expect(b).not.toBeNull();
    expect(b && boundsApproxEquals(b, boundsFromRect(110, 60, 20, 20))).toBe(true);
  });

  it('unions children for a container', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({ type: 'group', name: 'g' });
    doc.insert<LayerNode>(
      {
        type: 'layer',
        name: 'a',
        transform: createTransform({ translation: vec2(0, 0) }),
        size: vec2(10, 10),
      },
      { parentId: g.id }
    );
    doc.insert<LayerNode>(
      {
        type: 'layer',
        name: 'b',
        transform: createTransform({ translation: vec2(20, 20) }),
        size: vec2(10, 10),
      },
      { parentId: g.id }
    );
    const b = doc.getWorldBounds(g.id);
    expect(b && boundsApproxEquals(b, boundsFromRect(0, 0, 30, 30))).toBe(true);
  });

  it('returns null for an empty container', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({ type: 'group', name: 'g' });
    expect(doc.getWorldBounds(g.id)).toBeNull();
  });
});

describe('hit testing', () => {
  it('returns the leaf whose world rect contains the point', () => {
    const doc = newDoc();
    const l = doc.insert<LayerNode>({
      type: 'layer',
      name: 'l',
      transform: createTransform({ translation: vec2(100, 100) }),
      size: vec2(50, 50),
    });
    expect(doc.hitTest(vec2(120, 120))?.id).toBe(l.id);
    expect(doc.hitTest(vec2(10, 10))).toBeUndefined();
  });

  it('does not hit an empty container directly', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({
      type: 'group',
      name: 'g',
      transform: createTransform({ translation: vec2(0, 0) }),
    });
    expect(doc.hitTest(vec2(5, 5))).toBeUndefined();
    void g;
  });

  it('returns the top-most (front) node when siblings overlap', () => {
    const doc = newDoc();
    doc.insert<LayerNode>({ type: 'layer', name: 'back', size: vec2(50, 50) });
    const front = doc.insert<LayerNode>({
      type: 'layer',
      name: 'front',
      size: vec2(50, 50),
    });
    expect(doc.hitTest(vec2(10, 10))?.id).toBe(front.id);
  });

  it('respects rotation via the inverse world transform', () => {
    const doc = newDoc();
    // A 20x20 layer rotated 45deg about its centre pivot, centred at (100,100).
    const l = doc.insert<LayerNode>({
      type: 'layer',
      name: 'l',
      size: vec2(20, 20),
      transform: createTransform({
        translation: vec2(100, 100),
        rotation: Math.PI / 4,
        pivot: vec2(10, 10),
      }),
    });
    expect(doc.hitTest(vec2(100, 100))?.id).toBe(l.id); // centre is inside
    // A corner of the axis-aligned box that the rotation moves outside the shape.
    expect(doc.hitTest(vec2(86, 86))).toBeUndefined();
  });
});
