import { createCamera } from './camera';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import { transformPoint } from './matrix';
import type { GroupNode, LayerNode } from './node';
import { buildRenderList, debugColorForId } from './render-list';
import { createTransform } from './transform';
import { approxEquals, vec2 } from './vec2';

function newDoc(): SceneDocument {
  return SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
}

describe('buildRenderList', () => {
  it('emits one quad per drawable leaf, mapping the unit square to screen', () => {
    const doc = newDoc();
    const layer = doc.insert<LayerNode>({
      type: 'layer',
      name: 'l',
      size: vec2(100, 50),
      transform: createTransform({ translation: vec2(10, 20) }),
    });

    const items = buildRenderList(doc, createCamera());
    expect(items).toHaveLength(1);
    expect(items[0].nodeId).toBe(layer.id);
    // unit (0,0) -> local (0,0) -> world/screen (10,20); unit (1,1) -> (110,70).
    expect(approxEquals(transformPoint(items[0].transform, vec2(0, 0)), vec2(10, 20))).toBe(true);
    expect(approxEquals(transformPoint(items[0].transform, vec2(1, 1)), vec2(110, 70))).toBe(true);
    expect(items[0].color).toEqual(debugColorForId(layer.id));
  });

  it('applies the camera', () => {
    const doc = newDoc();
    doc.insert<LayerNode>({ type: 'layer', name: 'l', size: vec2(10, 10) });
    const items = buildRenderList(doc, createCamera({ pan: vec2(5, 5), zoom: 2 }));
    // unit (0,0) -> world (0,0) -> screen pan = (5,5).
    expect(approxEquals(transformPoint(items[0].transform, vec2(0, 0)), vec2(5, 5))).toBe(true);
    // unit (1,1) -> world (10,10) -> screen (5 + 2*10) = (25,25).
    expect(approxEquals(transformPoint(items[0].transform, vec2(1, 1)), vec2(25, 25))).toBe(true);
  });

  it('skips containers and empty groups, and preserves draw order', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({ type: 'group', name: 'g' });
    const a = doc.insert<LayerNode>({ type: 'layer', name: 'a', size: vec2(10, 10) }, { parentId: g.id });
    const b = doc.insert<LayerNode>({ type: 'layer', name: 'b', size: vec2(10, 10) });
    const items = buildRenderList(doc, createCamera());
    expect(items.map((i) => i.nodeId)).toEqual([a.id, b.id]);
  });

  it('produces deterministic, opaque debug colours', () => {
    const c = debugColorForId(createSequentialIdFactory('x')());
    expect(c.a).toBe(1);
    for (const ch of [c.r, c.g, c.b]) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(1);
    }
  });
});
