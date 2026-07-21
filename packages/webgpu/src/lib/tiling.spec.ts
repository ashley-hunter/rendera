import {
  ellipsePath,
  pathBounds,
  pathEdges,
  rectPath,
  toQuadraticPath,
  transformPath,
  type Path,
  type PathEdge,
} from '@rendera/core';
import { buildTiles, windEdge } from './tiling';
import glyphs from './__fixtures__/serif-glyphs.json';

/** Ground-truth winding at a point: sum over ALL edges (what the untiled shader
 *  computes). The tiled result must equal this everywhere. */
function trueWinding(edges: readonly PathEdge[], x: number, y: number): number {
  let w = 0;
  for (const e of edges) w += windEdge(e, x, y);
  return w;
}

/** Assert backdrop + per-tile winding == ground truth at a dense set of sample
 *  points (offset off the integer grid so some land near tile boundaries). */
function checkPath(path: Path, tol: number): void {
  const edges = pathEdges(toQuadraticPath(path, tol));
  const b = pathBounds(path);
  if (!b || edges.length === 0) throw new Error('empty path');
  const tileSize = 16;
  const grid = buildTiles(edges, b, 2, tileSize);

  let checked = 0;
  const step = Math.max(1.3, Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 90);
  for (let y = b.minY - 3; y <= b.maxY + 3; y += step) {
    for (let x = b.minX - 3; x <= b.maxX + 3; x += step) {
      const tx = Math.min(grid.tilesX - 1, Math.max(0, Math.floor((x - grid.originX) / tileSize)));
      const ty = Math.min(grid.tilesY - 1, Math.max(0, Math.floor((y - grid.originY) / tileSize)));
      const tile = grid.tiles[ty * grid.tilesX + tx];
      let w = tile.backdrop;
      for (let j = 0; j < tile.count; j++) w += windEdge(edges[grid.edgeIndex[tile.offset + j]], x, y);
      expect(w).toBe(trueWinding(edges, x, y));
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(100);
}

const glyphPaths = glyphs as Record<string, Path>;

describe('per-tile winding backdrop', () => {
  it('matches ground truth for a simple rectangle', () => {
    checkPath(rectPath(10, 10, 120, 90), 0.2);
  });

  it('matches ground truth for an even-odd donut (nested rects)', () => {
    // The exact case the naive per-corner backdrop misfilled.
    checkPath(
      { subpaths: [rectPath(8, 8, 160, 160).subpaths[0], rectPath(70, 70, 40, 40).subpaths[0]] },
      0.2
    );
  });

  it('matches ground truth for an ellipse (curved edges)', () => {
    checkPath(ellipsePath(80, 60, 70, 45), 0.15);
  });

  it('matches ground truth for overlapping shapes (multiple crossings per row)', () => {
    checkPath(
      { subpaths: [ellipsePath(60, 60, 40, 40).subpaths[0], ellipsePath(90, 60, 40, 40).subpaths[0]] },
      0.15
    );
  });

  for (const ch of ['V', 'e', 'o', 'a', 'c', 't', 'r', 's']) {
    it(`matches ground truth for the serif glyph '${ch}'`, () => {
      const g = glyphPaths[ch];
      if (!g) throw new Error(`no fixture for ${ch}`);
      checkPath(g, 2);
    });
  }

  for (const s of [0.5, 1, 30]) {
    it(`matches ground truth for a glyph scaled ${s}x (tiling holds at zoom)`, () => {
      const g = transformPath(glyphPaths['e'], { a: s, b: 0, c: 0, d: s, e: 0, f: 0 });
      checkPath(g, 2 * s);
    });
  }
});
