import { importSvg } from './import';
import { SceneDocument } from '../document';
import { createSequentialIdFactory } from '../id';
import type { GroupNode, PathNode, TextNode } from '../node';
import { toMatrix } from '../transform';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });

describe('importSvg', () => {
  it('wraps the tree in a root group and reports the viewport size', () => {
    const d = doc();
    const r = importSvg(d, '<svg width="200" height="100"><rect x="0" y="0" width="10" height="10"/></svg>');
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
    const root = d.get(r.rootId) as GroupNode;
    expect(root.type).toBe('group');
    expect(d.getChildren(r.rootId)).toHaveLength(1);
  });

  it('maps a viewBox to the viewport with a uniform meet scale', () => {
    const d = doc();
    const r = importSvg(d, '<svg width="200" height="200" viewBox="0 0 100 100"><rect width="1" height="1"/></svg>');
    const root = d.get(r.rootId) as GroupNode;
    // 100 -> 200 is a 2x uniform scale, centred (square, so no offset).
    const m = toMatrix(root.transform);
    expect(m.a).toBeCloseTo(2);
    expect(m.d).toBeCloseTo(2);
    expect(m.e).toBeCloseTo(0);
  });

  it('imports basic shapes as path nodes with resolved fills', () => {
    const d = doc();
    const r = importSvg(
      d,
      '<svg><rect width="10" height="10" fill="#ff0000"/><circle cx="5" cy="5" r="3" fill="lime"/></svg>'
    );
    const kids = d.getChildren(r.rootId) as PathNode[];
    expect(kids).toHaveLength(2);
    expect(kids[0].type).toBe('path');
    expect(kids[0].fill).toMatchObject({ type: 'solid' });
    // #ff0000 -> linear red (r≈1, g=b=0).
    const fill = kids[0].fill as { type: 'solid'; color: { r: number; g: number; b: number } };
    expect(fill.color.r).toBeCloseTo(1);
    expect(fill.color.g).toBeCloseTo(0);
  });

  it('inherits presentation attributes down a group and applies its transform', () => {
    const d = doc();
    const r = importSvg(
      d,
      '<svg><g fill="blue" transform="translate(20 0)"><rect width="4" height="4"/></g></svg>'
    );
    const group = d.getChildren(r.rootId)[0] as GroupNode;
    expect(group.type).toBe('group');
    expect(toMatrix(group.transform).e).toBeCloseTo(20);
    const rect = d.getChildren(group.id)[0] as PathNode;
    const fill = rect.fill as { type: 'solid'; color: { b: number } };
    expect(fill.color.b).toBeCloseTo(1); // inherited blue
  });

  it('lets inline style override presentation attributes', () => {
    const d = doc();
    const r = importSvg(d, '<svg><rect width="4" height="4" fill="red" style="fill:#00ff00"/></svg>');
    const rect = d.getChildren(r.rootId)[0] as PathNode;
    const fill = rect.fill as { type: 'solid'; color: { g: number; r: number } };
    expect(fill.color.g).toBeCloseTo(1);
    expect(fill.color.r).toBeCloseTo(0);
  });

  it('resolves a gradient fill into a local-space paint', () => {
    const d = doc();
    const r = importSvg(
      d,
      `<svg><defs><linearGradient id="g"><stop offset="0" stop-color="black"/><stop offset="1" stop-color="white"/></linearGradient></defs>` +
        `<rect x="0" y="0" width="100" height="20" fill="url(#g)"/></svg>`
    );
    const rect = d.getChildren(r.rootId)[0] as PathNode;
    const fill = rect.fill as { type: string; start: { x: number }; end: { x: number }; stops: unknown[] };
    expect(fill.type).toBe('linear-gradient');
    // objectBoundingBox default x1=0..x2=1 maps across the rect's local width.
    expect(fill.start.x).toBeCloseTo(0);
    expect(fill.end.x).toBeCloseTo(100);
    expect(fill.stops).toHaveLength(2);
  });

  it('imports a stroke-only shape (line) and no fill', () => {
    const d = doc();
    const r = importSvg(d, '<svg><line x1="0" y1="0" x2="10" y2="10" stroke="black" stroke-width="2"/></svg>');
    const line = d.getChildren(r.rootId)[0] as PathNode;
    expect(line.fill).toBeUndefined();
    expect(line.stroke).toMatchObject({ width: 2 });
    expect(line.path.subpaths[0].closed).toBe(false);
  });

  it('imports text as a text node and reports the font', () => {
    const d = doc();
    const r = importSvg(
      d,
      '<svg><text x="10" y="30" font-family="Inter" font-size="24" text-anchor="middle">Hi</text></svg>',
      { fontFor: (family) => (family === 'Inter' ? 'inter' : 'fallback') }
    );
    expect(r.fonts).toContain('inter');
    const text = d.getChildren(r.rootId)[0] as TextNode;
    expect(text.type).toBe('text');
    expect(text.text).toBe('Hi');
    expect(text.fontSize).toBe(24);
    expect(text.fontId).toBe('inter');
    expect(text.align).toBe('center');
  });

  it('wires a clip-path reference onto the node as a clip region', () => {
    const d = doc();
    const r = importSvg(
      d,
      '<svg><defs><clipPath id="c"><rect x="0" y="0" width="20" height="20"/></clipPath></defs>' +
        '<rect width="100" height="100" fill="red" clip-path="url(#c)"/></svg>'
    );
    const rect = d.getChildren(r.rootId).find((n) => n.type === 'path') as PathNode;
    expect(rect.clip).toBeDefined();
    expect(rect.clip?.path.subpaths.length).toBe(1);
  });

  it('materializes a <mask> as a mask node and references it', () => {
    const d = doc();
    const r = importSvg(
      d,
      '<svg><defs><mask id="m"><rect width="100" height="100" fill="white"/></mask></defs>' +
        '<circle cx="50" cy="50" r="40" fill="blue" mask="url(#m)"/></svg>'
    );
    const kids = d.getChildren(r.rootId);
    const maskNode = kids.find((n) => n.type === 'mask');
    expect(maskNode).toBeDefined();
    // The mask's content was imported as its child.
    expect(d.getChildren(maskNode!.id).length).toBeGreaterThan(0);
    const circle = kids.find((n) => n.type === 'path') as PathNode;
    expect(circle.mask?.maskId).toBe(maskNode!.id);
  });

  it('throws on a non-svg root', () => {
    expect(() => importSvg(doc(), '<html></html>')).toThrow();
  });
});
