import { createCamera } from './camera';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import { transformPoint } from './matrix';
import type { BooleanNode, GroupNode, ImageNode, LayerNode, MaskNode, PathNode } from './node';
import type { NodeId } from './id';
import { ellipsePath, rectPath } from './path';
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

  it('emits a draw-path with screen-space edges and resolved fill', () => {
    const doc = newDoc();
    const node = doc.insert<PathNode>({
      type: 'path',
      name: 'p',
      path: rectPath(0, 0, 10, 10),
      fill: { type: 'solid', color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } },
      transform: createTransform({ translation: vec2(5, 5) }),
    });
    // Camera zoom 2 so we can check the geometry is baked to screen space.
    const cmds = buildRenderList(doc, createCamera({ zoom: 2 }));
    expect(cmds).toHaveLength(1);
    const cmd = cmds[0];
    expect(cmd.op).toBe('draw-path');
    if (cmd.op !== 'draw-path') throw new Error('expected draw-path');
    expect(cmd.nodeId).toBe(node.id);
    expect(cmd.paint).toEqual({ type: 'solid', color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } });
    expect(cmd.fillRule).toBe('nonzero');
    // Rect (0,0,10,10) translated (5,5), zoom 2 -> screen bbox (10,10)..(30,30).
    expect(cmd.bounds.minX).toBeCloseTo(10, 5);
    expect(cmd.bounds.maxX).toBeCloseTo(30, 5);
    // 3 line segments + 1 close.
    expect(cmd.edges).toHaveLength(4);
  });

  it('emits a gradient fill with local geometry and a screen->local matrix', () => {
    const doc = newDoc();
    doc.insert<PathNode>({
      type: 'path',
      name: 'g',
      path: rectPath(0, 0, 10, 10),
      fill: {
        type: 'linear-gradient',
        start: vec2(0, 0),
        end: vec2(10, 0),
        stops: [
          { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
    });
    // Zoom 2: local (10,0) maps to screen (20,0); the inverse must undo it.
    const cmd = buildRenderList(doc, createCamera({ zoom: 2 }))[0];
    expect(cmd.op).toBe('draw-path');
    if (cmd.op !== 'draw-path') throw new Error('expected draw-path');
    expect(cmd.paint.type).toBe('linear-gradient');
    // screenToLocal maps a screen point back to local space (undoes the zoom).
    expect(approxEquals(transformPoint(cmd.screenToLocal, vec2(20, 20)), vec2(10, 10))).toBe(true);
  });

  it('folds a boolean node into one combined draw-path (operands not drawn)', () => {
    const doc = newDoc();
    const bool = doc.insert<BooleanNode>({
      type: 'boolean',
      name: 'b',
      op: 'union',
      fill: { type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } },
    });
    doc.insert<PathNode>({ type: 'path', name: 'a', path: ellipsePath(0, 0, 10, 10) }, { parentId: bool.id });
    doc.insert<PathNode>({ type: 'path', name: 'c', path: ellipsePath(8, 0, 10, 10) }, { parentId: bool.id });

    const paths = buildRenderList(doc, createCamera()).filter((c) => c.op === 'draw-path');
    expect(paths).toHaveLength(1); // the two operands become one combined path
    const cmd = paths[0];
    if (cmd.op !== 'draw-path') throw new Error('expected draw-path');
    expect(cmd.paint).toEqual({ type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } });
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

describe('buildRenderList — clip & mask', () => {
  const white = { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } as const;

  it('wraps a clipped path in a mask bracket + alpha-masked group', () => {
    const doc = newDoc();
    doc.insert<PathNode>({
      type: 'path',
      name: 'p',
      path: rectPath(0, 0, 100, 100),
      fill: white,
      clip: { path: rectPath(0, 0, 50, 50) },
    });
    const cmds = buildRenderList(doc, createCamera());
    expect(cmds.map((c) => c.op)).toEqual(['push-mask', 'draw-path', 'pop-mask', 'push-group', 'draw-path', 'pop-group']);
    const pg = cmds.find((c) => c.op === 'push-group');
    expect(pg?.op === 'push-group' && pg.mask).toEqual({ type: 'alpha' });
  });

  it('emits a mask node’s content as luminance coverage for a masked node', () => {
    const doc = newDoc();
    const mask = doc.insert<MaskNode>({ type: 'mask', name: 'm' });
    doc.insert<PathNode>({ type: 'path', name: 'grad', path: ellipsePath(50, 50, 40, 40), fill: white }, { parentId: mask.id });
    doc.insert<PathNode>({
      type: 'path',
      name: 'p',
      path: rectPath(0, 0, 100, 100),
      fill: white,
      mask: { maskId: mask.id },
    });
    const cmds = buildRenderList(doc, createCamera());
    // The mask node itself is not drawn in the main traversal.
    expect(cmds.map((c) => c.op)).toEqual(['push-mask', 'draw-path', 'pop-mask', 'push-group', 'draw-path', 'pop-group']);
    const pg = cmds.find((c) => c.op === 'push-group');
    expect(pg?.op === 'push-group' && pg.mask).toEqual({ type: 'luminance' });
  });

  it('nests two brackets when a node has both a mask and a clip, opacity on the outer group', () => {
    const doc = newDoc();
    const mask = doc.insert<MaskNode>({ type: 'mask', name: 'm' });
    doc.insert<PathNode>({ type: 'path', name: 'mc', path: rectPath(0, 0, 100, 100), fill: white }, { parentId: mask.id });
    doc.insert<PathNode>({
      type: 'path',
      name: 'p',
      path: rectPath(0, 0, 100, 100),
      fill: white,
      opacity: 0.5,
      mask: { maskId: mask.id, type: 'alpha' },
      clip: { path: rectPath(0, 0, 50, 50) },
    });
    const cmds = buildRenderList(doc, createCamera());
    const pushGroups = cmds.filter((c) => c.op === 'push-group');
    expect(pushGroups).toHaveLength(2);
    // Outermost group carries the node opacity; inner is opacity 1.
    expect(pushGroups[0].op === 'push-group' && pushGroups[0].opacity).toBe(0.5);
    expect(pushGroups[1].op === 'push-group' && pushGroups[1].opacity).toBe(1);
    expect(cmds.filter((c) => c.op === 'pop-group')).toHaveLength(2);
  });

  it('clips a group by wrapping its children', () => {
    const doc = newDoc();
    const g = doc.insert<GroupNode>({ type: 'group', name: 'g', clip: { path: rectPath(0, 0, 50, 50) } });
    doc.insert<PathNode>({ type: 'path', name: 'a', path: rectPath(0, 0, 100, 100), fill: white }, { parentId: g.id });
    doc.insert<PathNode>({ type: 'path', name: 'b', path: rectPath(0, 0, 100, 100), fill: white }, { parentId: g.id });
    const cmds = buildRenderList(doc, createCamera());
    expect(cmds.map((c) => c.op)).toEqual([
      'push-mask',
      'draw-path',
      'pop-mask',
      'push-group',
      'draw-path',
      'draw-path',
      'pop-group',
    ]);
  });

  it('ignores an invalid mask reference (renders the node normally)', () => {
    const doc = newDoc();
    doc.insert<PathNode>({
      type: 'path',
      name: 'p',
      path: rectPath(0, 0, 100, 100),
      fill: white,
      mask: { maskId: 'nope' as NodeId },
    });
    const cmds = buildRenderList(doc, createCamera());
    expect(cmds.map((c) => c.op)).toEqual(['draw-path']);
  });
});
