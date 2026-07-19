import { createDefaultRegistry, NodeRegistry, type NodeUtil } from './registry';

const groupUtil: NodeUtil = { type: 'group', canHaveChildren: () => true };

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
});
