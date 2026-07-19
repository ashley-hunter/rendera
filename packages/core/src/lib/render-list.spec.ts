import { createCamera } from './camera';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import { transformPoint } from './matrix';
import type { GroupNode, ImageNode, LayerNode } from './node';
import {
  buildRenderList,
  debugColorForId,
  type DrawImageCommand,
  type DrawSolidCommand,
} from './render-list';
import { createTransform } from './transform';
import { approxEquals, vec2 } from './vec2';

function newDoc(): SceneDocument {
  return SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
}

describe('buildRenderList', () => {
  it('emits a draw-solid per drawable leaf, mapping the unit square to screen', () => {
    const doc = newDoc();
    const layer = doc.insert<LayerNode>({
      type: 'layer',
      name: 'l',
      size: vec2(100, 50),
      fill: { type: 'solid', color: { r: 0.2, g: 0.4, b: 0.6, a: 1 } },
      transform: createTransform({ translation: vec2(10, 20) }),
    });

    const cmds = buildRenderList(doc, createCamera());
    expect(cmds).toHaveLength(1);
    const cmd = cmds[0];
    expect(cmd.op).toBe('draw-solid');
    if (cmd.op !== 'draw-solid') throw new Error('expected draw-solid');
    expect(cmd.nodeId).toBe(layer.id);
    expect(cmd.color).toEqual({ r: 0.2, g: 0.4, b: 0.6, a: 1 });
    expect(cmd.opacity).toBe(1);
    expect(cmd.blend).toBe('normal');
    // unit (0,0) -> (10,20); unit (1,1) -> (110,70).
    expect(approxEquals(transformPoint(cmd.transform, vec2(0, 0)), vec2(10, 20))).toBe(true);
    expect(approxEquals(transformPoint(cmd.transform, vec2(1, 1)), vec2(110, 70))).toBe(true);
  });

  it('defaults a fill-less layer to opaque mid-grey', () => {
    const doc = newDoc();
    doc.insert<LayerNode>({ type: 'layer', name: 'l', size: vec2(10, 10) });
    const cmd = buildRenderList(doc, createCamera())[0] as DrawSolidCommand;
    expect(cmd.color).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  });

  it('carries opacity and blend mode from the node', () => {
    const doc = newDoc();
    doc.insert<LayerNode>({
      type: 'layer',
      name: 'l',
      size: vec2(10, 10),
      opacity: 0.4,
      blendMode: 'multiply',
    });
    const cmd = buildRenderList(doc, createCamera())[0];
    expect(cmd.op === 'draw-solid' && cmd.opacity).toBe(0.4);
    expect(cmd.op === 'draw-solid' && cmd.blend).toBe('multiply');
  });

  it('emits a draw-image with the asset reference', () => {
    const doc = newDoc();
    const image = doc.insert<ImageNode>({
      type: 'image',
      name: 'photo',
      size: vec2(64, 48),
      assetId: 'asset-42',
      opacity: 0.5,
    });
    const cmd = buildRenderList(doc, createCamera())[0] as DrawImageCommand;
    expect(cmd.op).toBe('draw-image');
    expect(cmd.assetId).toBe('asset-42');
    expect(cmd.opacity).toBe(0.5);
    expect(cmd.nodeId).toBe(image.id);
  });

  it('applies the camera', () => {
    const doc = newDoc();
    doc.insert<LayerNode>({ type: 'layer', name: 'l', size: vec2(10, 10) });
    const cmd = buildRenderList(doc, createCamera({ pan: vec2(5, 5), zoom: 2 }))[0];
    expect(approxEquals(transformPoint(cmd.transform, vec2(0, 0)), vec2(5, 5))).toBe(true);
    expect(approxEquals(transformPoint(cmd.transform, vec2(1, 1)), vec2(25, 25))).toBe(true);
  });

  it('treats a plain group as pass-through (no push/pop)', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({ type: 'group', name: 'g' });
    const a = doc.insert<LayerNode>({ type: 'layer', name: 'a', size: vec2(10, 10) }, { parentId: g.id });
    const b = doc.insert<LayerNode>({ type: 'layer', name: 'b', size: vec2(10, 10) });
    const cmds = buildRenderList(doc, createCamera());
    expect(cmds.map((c) => c.op)).toEqual(['draw-solid', 'draw-solid']);
    expect(cmds.map((c) => c.nodeId)).toEqual([a.id, b.id]);
  });

  it('isolates a group with opacity < 1 via push/pop', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({ type: 'group', name: 'g', opacity: 0.5 });
    doc.insert<LayerNode>({ type: 'layer', name: 'a', size: vec2(10, 10) }, { parentId: g.id });
    const cmds = buildRenderList(doc, createCamera());
    expect(cmds.map((c) => c.op)).toEqual(['push-group', 'draw-solid', 'pop-group']);
    const push = cmds[0];
    if (push.op !== 'push-group') throw new Error('expected push');
    expect(push.opacity).toBe(0.5);
    expect(push.nodeId).toBe(g.id);
  });

  it('isolates a group with a non-Normal blend mode', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({ type: 'group', name: 'g', blendMode: 'screen' });
    doc.insert<LayerNode>({ type: 'layer', name: 'a', size: vec2(10, 10) }, { parentId: g.id });
    const cmds = buildRenderList(doc, createCamera());
    expect(cmds.map((c) => c.op)).toEqual(['push-group', 'draw-solid', 'pop-group']);
    expect(cmds[0].op === 'push-group' && cmds[0].blend).toBe('screen');
  });

  it('isolates a group marked isolate even at opacity 1 / Normal', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({ type: 'group', name: 'g', isolate: true });
    doc.insert<LayerNode>({ type: 'layer', name: 'a', size: vec2(10, 10) }, { parentId: g.id });
    expect(buildRenderList(doc, createCamera()).map((c) => c.op)).toEqual([
      'push-group',
      'draw-solid',
      'pop-group',
    ]);
  });

  it('skips a hidden node and its subtree', () => {
    const doc = newDoc();
    doc.insert<LayerNode>({ type: 'layer', name: 'shown', size: vec2(10, 10) });
    doc.insert<LayerNode>({ type: 'layer', name: 'hidden', size: vec2(10, 10), visible: false });
    const g = doc.insert<GroupNode>({ type: 'group', name: 'g', visible: false });
    doc.insert<LayerNode>({ type: 'layer', name: 'child', size: vec2(10, 10) }, { parentId: g.id });
    const cmds = buildRenderList(doc, createCamera());
    expect(cmds).toHaveLength(1);
    expect(cmds[0].op).toBe('draw-solid');
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
