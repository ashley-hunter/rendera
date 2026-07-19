import { createCamera } from './camera';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import { transformPoint } from './matrix';
import type { GroupNode, ImageNode, LayerNode } from './node';
import { buildRenderList, debugColorForId, type QuadDrawItem } from './render-list';
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
    const item = items[0];
    expect(item.nodeId).toBe(layer.id);
    // unit (0,0) -> local (0,0) -> world/screen (10,20); unit (1,1) -> (110,70).
    expect(approxEquals(transformPoint(item.transform, vec2(0, 0)), vec2(10, 20))).toBe(true);
    expect(approxEquals(transformPoint(item.transform, vec2(1, 1)), vec2(110, 70))).toBe(true);
    expect(item.kind).toBe('solid');
    expect((item as QuadDrawItem).color).toEqual(debugColorForId(layer.id));
  });

  it('emits an image draw item carrying the asset reference and opacity', () => {
    const doc = newDoc();
    const image = doc.insert<ImageNode>({
      type: 'image',
      name: 'photo',
      size: vec2(64, 48),
      assetId: 'asset-42',
      opacity: 0.5,
      transform: createTransform({ translation: vec2(10, 20) }),
    });
    const items = buildRenderList(doc, createCamera());
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.kind).toBe('image');
    if (item.kind !== 'image') throw new Error('expected image item');
    expect(item.assetId).toBe('asset-42');
    expect(item.opacity).toBe(0.5);
    // Same unit-square -> screen mapping as any other leaf.
    expect(approxEquals(transformPoint(item.transform, vec2(1, 1)), vec2(74, 68))).toBe(true);
    expect(item.nodeId).toBe(image.id);
  });

  it('defaults image opacity to 1 when omitted', () => {
    const doc = newDoc();
    doc.insert<ImageNode>({ type: 'image', name: 'p', size: vec2(8, 8), assetId: 'a' });
    const item = buildRenderList(doc, createCamera())[0];
    if (item.kind !== 'image') throw new Error('expected image item');
    expect(item.opacity).toBe(1);
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
