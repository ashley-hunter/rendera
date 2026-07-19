import { boundsFromRect } from './bounds';
import { createDefaultRegistry, NodeRegistry, type NodeUtil } from './registry';
import { vec2 } from './vec2';

const groupUtil: NodeUtil = {
  type: 'group',
  canHaveChildren: () => true,
  isSpatial: () => true,
  createDefaults: () => ({}),
  getLocalBounds: () => null,
  hitTestLocal: () => false,
};

describe('NodeRegistry', () => {
  it('registers, looks up, and reports presence', () => {
    const registry = new NodeRegistry();
    expect(registry.has('group')).toBe(false);
    registry.register(groupUtil);
    expect(registry.has('group')).toBe(true);
    expect(registry.get('group')).toBe(groupUtil);
    expect(registry.require('group')).toBe(groupUtil);
  });

  it('throws on duplicate registration and unknown lookup', () => {
    const registry = new NodeRegistry().register(groupUtil);
    expect(() => registry.register(groupUtil)).toThrow(/already registered/);
    expect(registry.get('nope')).toBeUndefined();
    expect(() => registry.require('nope')).toThrow(/no node util/);
  });
});

describe('createDefaultRegistry', () => {
  it('knows the built-in node types and their child-ability', () => {
    const registry = createDefaultRegistry();
    expect(registry.require('document').canHaveChildren()).toBe(true);
    expect(registry.require('group').canHaveChildren()).toBe(true);
    expect(registry.require('layer').canHaveChildren()).toBe(false);
  });

  it('reports spatiality and leaf geometry', () => {
    const registry = createDefaultRegistry();
    expect(registry.require('document').isSpatial()).toBe(false);
    expect(registry.require('group').isSpatial()).toBe(true);

    const layerUtil = registry.require('layer');
    const layer = { size: vec2(30, 40) } as never;
    expect(layerUtil.getLocalBounds(layer)).toEqual(boundsFromRect(0, 0, 30, 40));
    expect(layerUtil.hitTestLocal(layer, vec2(15, 20))).toBe(true);
    expect(layerUtil.hitTestLocal(layer, vec2(40, 20))).toBe(false);
  });
});
