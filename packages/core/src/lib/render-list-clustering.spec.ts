import { buildRenderList } from './render-list';
import { createCamera } from './camera';
import { SceneDocument } from './document';
import { createSequentialIdFactory } from './id';
import { ellipsePath } from './path';
import type { PathNode } from './node';
import type { Path } from './path';

function circleRow(count: number): Path {
  const subpaths: Path['subpaths'] = [];
  for (let i = 0; i < count; i++) {
    subpaths.push(...ellipsePath(i * 60, 0, 8, 8).subpaths);
  }
  return { subpaths };
}

const drawPaths = (doc: SceneDocument) =>
  buildRenderList(doc, createCamera()).filter((c) => c.op === 'draw-path');

describe('draw-path clustering (per-glyph culling)', () => {
  it('splits a run of disjoint shapes into one draw-path each', () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'row',
      path: circleRow(12),
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
    });
    const paths = drawPaths(doc);
    expect(paths.length).toBe(12);
    // Each command carries only its own circle's edges, so a fragment tests a
    // fraction of the run instead of all of it.
    for (const p of paths) {
      if (p.op === 'draw-path') expect(p.edges.length).toBeLessThan(12);
    }
  });

  it('keeps a single connected shape as one draw-path', () => {
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'o',
      path: ellipsePath(0, 0, 40, 40), // one outer ring (with its hole overlaps → same cluster)
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
    });
    expect(drawPaths(doc).length).toBe(1);
  });

  it('groups overlapping subpaths (a glyph and its counter) together', () => {
    // Two concentric rings (letter-'o'-like) overlap in bbox → one cluster.
    const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
    doc.insert<PathNode>({
      type: 'path',
      name: 'ring',
      path: { subpaths: [...ellipsePath(0, 0, 40, 40).subpaths, ...ellipsePath(0, 0, 24, 24).subpaths] },
      fill: { type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
      fillRule: 'evenodd',
    });
    expect(drawPaths(doc).length).toBe(1);
  });
});
