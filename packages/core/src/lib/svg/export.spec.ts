import { SceneDocument } from '../document';
import { createSequentialIdFactory } from '../id';
import type { GroupNode, PathNode } from '../node';
import { ellipsePath, pathBounds, rectPath } from '../path';
import { exportSvg } from './export';
import { importSvg } from './import';

const doc = () => SceneDocument.create({ idFactory: createSequentialIdFactory('n') });

function findPath(d: SceneDocument, id: string): PathNode | null {
  const n = d.get(id);
  if (n?.type === 'path') return n as PathNode;
  for (const c of d.getChildren(id)) {
    const found = findPath(d, c.id);
    if (found) return found;
  }
  return null;
}

describe('exportSvg', () => {
  it('serializes a solid-filled, stroked path', () => {
    const d = doc();
    d.insert<PathNode>({
      type: 'path',
      name: 'r',
      path: rectPath(10, 20, 80, 60),
      fill: { type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } }, // linear red → #ff0000
      stroke: { paint: { type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }, width: 4, join: 'round' },
    });
    const svg = exportSvg(d);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="10 20 80 60"');
    expect(svg).toContain('<path d="M10 20 L90 20 L90 80 L10 80 Z"');
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toContain('stroke-width="4"');
    expect(svg).toContain('stroke-linejoin="round"');
  });

  it('emits a <defs> linear gradient and references it', () => {
    const d = doc();
    d.insert<PathNode>({
      type: 'path',
      name: 'g',
      path: rectPath(0, 0, 100, 100),
      fill: {
        type: 'linear-gradient',
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
        stops: [
          { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
    });
    const svg = exportSvg(d);
    expect(svg).toContain('<defs>');
    expect(svg).toContain('<linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"');
    expect(svg).toContain('<stop offset="0" stop-color="#ff0000"');
    expect(svg).toContain('<stop offset="1" stop-color="#0000ff"');
    expect(svg).toContain('fill="url(#g0)"');
  });

  it('wraps children in a <g> with transform and opacity', () => {
    const d = doc();
    const g = d.insert<GroupNode>({ type: 'group', name: 'grp', opacity: 0.5 });
    d.update(g.id, { transform: { translation: { x: 5, y: 7 }, rotation: 0, scale: { x: 2, y: 2 }, skew: 0, pivot: { x: 0, y: 0 } } });
    d.insert<PathNode>({ type: 'path', name: 'c', path: rectPath(0, 0, 10, 10), fill: { type: 'solid', color: { r: 0, g: 1, b: 0, a: 1 } } }, { parentId: g.id });
    const svg = exportSvg(d);
    expect(svg).toContain('<g id="grp" transform="matrix(2 0 0 2 5 7)" opacity="0.5">');
    expect(svg).toContain('fill="#00ff00"');
  });

  it('round-trips path geometry and fill through import', () => {
    const src = doc();
    src.insert<PathNode>({
      type: 'path',
      name: 'e',
      path: ellipsePath(50, 40, 30, 20),
      fill: { type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } },
      fillRule: 'evenodd',
    });
    const svg = exportSvg(src);

    const back = doc();
    const r = importSvg(back, svg);
    const p = findPath(back, r.rootId);
    expect(p).not.toBeNull();
    // Geometry survives (local path coords are authored, viewBox maps 1:1 here).
    const a = pathBounds(ellipsePath(50, 40, 30, 20))!;
    const b = pathBounds(p!.path)!;
    expect(b.minX).toBeCloseTo(a.minX, 2);
    expect(b.maxX).toBeCloseTo(a.maxX, 2);
    expect(b.minY).toBeCloseTo(a.minY, 2);
    expect(b.maxY).toBeCloseTo(a.maxY, 2);
    // Fill survives (linear red → #ff0000 → linear red).
    expect(p!.fill).toEqual({ type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } });
    expect(p!.fillRule).toBe('evenodd');
  });
});
