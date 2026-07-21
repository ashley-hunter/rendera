/**
 * Per-tile winding backdrop for the analytic path fill (a foundation step toward
 * fully tiled rasterization — see ADR 0007).
 *
 * The fill shader computes, per pixel, a winding number (rightward-ray edge
 * crossings) plus the exact distance to the nearest edge. Walking *every* edge in
 * a horizontal band is wasteful once a shape is magnified. This module bins the
 * edges into a 2D tile grid so a fragment tests only its tile's edges, and gives
 * each tile a **backdrop**: the winding carried in from every edge the tile's own
 * list does not cover. Then
 *
 *     winding(pixel) = backdrop(tile) + windRay(pixel ; tile edges)
 *
 * The backdrop is defined exactly as
 *
 *     backdrop = trueWinding(tileCorner) − windRay(tileCorner ; tile edges)
 *
 * (trueWinding = the winding over ALL edges, at the tile's top-left corner). This
 * identity holds for ANY tile edge set S as long as every edge NOT in S has the
 * same rightward-ray crossing count at the corner and at any pixel in the tile —
 * i.e. every edge whose y-range *starts or ends inside the tile's strip* (a
 * "partial" edge, which a rightward ray may cross for some rows of the tile but
 * not others) is in S. Edges that span the whole strip ("through") or miss it
 * contribute equally at corner and pixel, so they can be left to the backdrop.
 * Adding extra edges to S is always safe — the backdrop subtracts them back out.
 *
 * So each tile's set is: the edges within `reach` of it (needed for the distance
 * field anyway) plus every edge that is partial in the tile's strip. The math is
 * pure and DOM-free, so it is unit-tested against a brute-force winding with no
 * GPU (`tiling.spec.ts`).
 */

import type { Bounds, PathEdge } from '@rendera/core';

/** One tile's slice of the shared edge-index array plus its winding backdrop. */
export interface TileEntry {
  /** Offset into `edgeIndex` of this tile's edge list. */
  readonly offset: number;
  /** Number of edges in the list. */
  readonly count: number;
  /** Winding carried in from every edge outside the list (constant over the tile). */
  readonly backdrop: number;
}

/** A draw's tile grid: geometry, the flattened per-tile edge lists, and backdrops. */
export interface TileGrid {
  readonly originX: number;
  readonly originY: number;
  readonly tileSize: number;
  readonly tilesX: number;
  readonly tilesY: number;
  /** Row-major (`ty * tilesX + tx`) tile entries. */
  readonly tiles: readonly TileEntry[];
  /** Edge indices (into the caller's edge array), grouped by tile. */
  readonly edgeIndex: readonly number[];
}

// --- winding at a point (rightward ray, half-open scanline) -------------------

function quadCrossX(
  ax: number, bx: number, cx: number,
  a2: number, b1: number, c0: number, tlo: number, thi: number
): number {
  let t = 0;
  if (Math.abs(a2) < 1e-6) {
    t = -c0 / b1;
  } else {
    const s = Math.sqrt(Math.max(b1 * b1 - 4 * a2 * c0, 0));
    const r0 = (-b1 - s) / (2 * a2);
    const r1 = (-b1 + s) / (2 * a2);
    t = r0;
    if (r0 < tlo - 1e-4 || r0 > thi + 1e-4) t = r1;
  }
  t = Math.min(thi, Math.max(tlo, t));
  const u = 1 - t;
  return u * u * ax + 2 * u * t * bx + t * t * cx;
}

function windSub(px: number, py: number, x: number, ya: number, yb: number): number {
  const up = ya <= py && yb > py;
  const down = yb <= py && ya > py;
  if (!up && !down) return 0;
  if (x > px) return up ? 1 : -1;
  return 0;
}

/** Winding contribution of one edge at a point (matches the WGSL windLine/windQuad). */
export function windEdge(e: PathEdge, px: number, py: number): number {
  if (!e.quad) {
    const ay = e.a.y;
    const cy = e.c.y;
    const up = ay <= py && cy > py;
    const down = cy <= py && ay > py;
    if (!up && !down) return 0;
    const t = (py - ay) / (cy - ay);
    if (e.a.x + t * (e.c.x - e.a.x) > px) return up ? 1 : -1;
    return 0;
  }
  const ax = e.a.x, ay = e.a.y, bx = e.b.x, by = e.b.y, cx = e.c.x, cy = e.c.y;
  const a2 = ay - 2 * by + cy;
  const b1 = 2 * (by - ay);
  const c0 = ay - py;
  if (Math.abs(a2) > 1e-6) {
    const tex = -b1 / (2 * a2);
    if (tex > 0 && tex < 1) {
      const uex = 1 - tex;
      const yex = uex * uex * ay + 2 * uex * tex * by + tex * tex * cy;
      return (
        windSub(px, py, quadCrossX(ax, bx, cx, a2, b1, c0, 0, tex), ay, yex) +
        windSub(px, py, quadCrossX(ax, bx, cx, a2, b1, c0, tex, 1), yex, cy)
      );
    }
  }
  return windSub(px, py, quadCrossX(ax, bx, cx, a2, b1, c0, 0, 1), ay, cy);
}

// --- crossings of a scanline over an edge (for the per-row true-winding sweep) -

function collectCrossings(e: PathEdge, y: number, out: { x: number; s: number }[]): void {
  if (!e.quad) {
    const ay = e.a.y;
    const cy = e.c.y;
    const up = ay <= y && cy > y;
    const down = cy <= y && ay > y;
    if (!up && !down) return;
    const t = (y - ay) / (cy - ay);
    out.push({ x: e.a.x + t * (e.c.x - e.a.x), s: up ? 1 : -1 });
    return;
  }
  const ax = e.a.x, ay = e.a.y, bx = e.b.x, by = e.b.y, cx = e.c.x, cy = e.c.y;
  const a2 = ay - 2 * by + cy;
  const b1 = 2 * (by - ay);
  const c0 = ay - y;
  const sub = (tlo: number, thi: number, ya: number, yb: number): void => {
    const up = ya <= y && yb > y;
    const down = yb <= y && ya > y;
    if (!up && !down) return;
    out.push({ x: quadCrossX(ax, bx, cx, a2, b1, c0, tlo, thi), s: up ? 1 : -1 });
  };
  if (Math.abs(a2) > 1e-6) {
    const tex = -b1 / (2 * a2);
    if (tex > 0 && tex < 1) {
      const uex = 1 - tex;
      const yex = uex * uex * ay + 2 * uex * tex * by + tex * tex * cy;
      sub(0, tex, ay, yex);
      sub(tex, 1, yex, cy);
      return;
    }
  }
  sub(0, 1, ay, cy);
}

/** The y-values where an edge starts/ends or turns (its endpoints + quad extremum).
 *  A tile strip that contains one of these makes the edge "partial" there. */
function specialYs(e: PathEdge): number[] {
  const ys = [e.a.y, e.c.y];
  if (e.quad) {
    const denom = e.a.y - 2 * e.b.y + e.c.y;
    if (Math.abs(denom) > 1e-9) {
      const t = (e.a.y - e.b.y) / denom;
      if (t > 0 && t < 1) {
        const u = 1 - t;
        ys.push(u * u * e.a.y + 2 * u * t * e.b.y + t * t * e.c.y);
      }
    }
  }
  return ys;
}

/**
 * Bin `edges` into a `tileSize` grid over `bounds` (padded by `pad`), with each
 * tile's edge list and winding backdrop (see the module comment). `reach` is how
 * far the distance field looks past an edge (so edges within it land in the tile).
 */
export function buildTiles(
  edges: readonly PathEdge[],
  bounds: Bounds,
  reach: number,
  tileSize: number,
  pad = 2,
  /** Fills need the winding backdrop; a distance-field stroke ignores winding, so
   *  it skips the strip-partials and the backdrop sweep (backdrop stays 0). */
  computeBackdrop = true
): TileGrid {
  const originX = bounds.minX - pad;
  const originY = bounds.minY - pad;
  const tilesX = Math.max(1, Math.ceil((bounds.maxX + pad - originX) / tileSize));
  const tilesY = Math.max(1, Math.ceil((bounds.maxY + pad - originY) / tileSize));
  const col = (x: number): number => Math.min(tilesX - 1, Math.max(0, Math.floor((x - originX) / tileSize)));
  const row = (y: number): number => Math.min(tilesY - 1, Math.max(0, Math.floor((y - originY) / tileSize)));

  // Per-tile edge sets: edges within reach (distance + winding) ∪ strip partials.
  const sets: number[][] = Array.from({ length: tilesX * tilesY }, () => []);
  const seen = new Int32Array(tilesX * tilesY).fill(-1); // last edge added to each tile
  const add = (tile: number, ei: number): void => {
    if (seen[tile] !== ei) {
      seen[tile] = ei;
      sets[tile].push(ei);
    }
  };
  edges.forEach((e, ei) => {
    // Distance reach: the tiles the edge actually passes through (within `reach`).
    // Binning by the whole edge bbox would be catastrophic for a long diagonal —
    // its bbox covers most of the grid, so its interior never goes empty. Instead
    // walk the edge in ~tile-size steps and bin each short sub-segment's (tight)
    // bbox: a superset of the traversed tiles, so every tile the edge crosses is
    // covered (required for the winding backdrop) with O(length) work, not O(area).
    const approxLen = e.quad
      ? Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) + Math.hypot(e.c.x - e.b.x, e.c.y - e.b.y)
      : Math.hypot(e.c.x - e.a.x, e.c.y - e.a.y);
    const n = Math.max(1, Math.ceil(approxLen / tileSize));
    let px = e.a.x;
    let py = e.a.y;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      let qx: number;
      let qy: number;
      if (e.quad) {
        const u = 1 - t;
        qx = u * u * e.a.x + 2 * u * t * e.b.x + t * t * e.c.x;
        qy = u * u * e.a.y + 2 * u * t * e.b.y + t * t * e.c.y;
      } else {
        qx = e.a.x + t * (e.c.x - e.a.x);
        qy = e.a.y + t * (e.c.y - e.a.y);
      }
      const c0 = col(Math.min(px, qx) - reach);
      const c1 = col(Math.max(px, qx) + reach);
      const r0 = row(Math.min(py, qy) - reach);
      const r1 = row(Math.max(py, qy) + reach);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) add(r * tilesX + c, ei);
      }
      px = qx;
      py = qy;
    }
    // Partial: a strip containing one of the edge's special y-values may cross a
    // rightward ray for some rows of a tile but not others, so it must be in the
    // list of every tile in that strip that a rightward ray could reach it from
    // — i.e. tiles at or left of the edge's rightmost extent (a ray from a tile
    // entirely right of the edge can't cross it). The backdrop can't represent it.
    if (computeBackdrop) {
      const cMax = col(Math.max(e.a.x, e.b.x, e.c.x));
      for (const sy of specialYs(e)) {
        if (sy < originY || sy > originY + tilesY * tileSize) continue;
        const r = row(sy);
        for (let c = 0; c <= cMax; c++) add(r * tilesX + c, ei);
      }
    }
  });

  // True winding at each tile's top-left corner, by one scanline sweep per row.
  const trueW = new Int32Array(tilesX * tilesY);
  const cross: { x: number; s: number }[] = [];
  for (let r = 0; computeBackdrop && r < tilesY; r++) {
    const cy = originY + r * tileSize;
    cross.length = 0;
    for (const e of edges) collectCrossings(e, cy, cross);
    cross.sort((u, v) => u.x - v.x);
    const n = cross.length;
    const suffix = new Int32Array(n + 1);
    for (let k = n - 1; k >= 0; k--) suffix[k] = suffix[k + 1] + cross[k].s;
    let ptr = 0;
    for (let c = 0; c < tilesX; c++) {
      const cx = originX + c * tileSize;
      while (ptr < n && cross[ptr].x <= cx) ptr++; // crossings strictly right of cx
      trueW[r * tilesX + c] = suffix[ptr];
    }
  }

  // backdrop = trueWinding(corner) − windRay(corner ; tile edges).
  const tiles: TileEntry[] = [];
  const edgeIndex: number[] = [];
  for (let r = 0; r < tilesY; r++) {
    for (let c = 0; c < tilesX; c++) {
      const tile = r * tilesX + c;
      let backdrop = 0;
      if (computeBackdrop) {
        const cx = originX + c * tileSize;
        const cy = originY + r * tileSize;
        let local = 0;
        for (const ei of sets[tile]) local += windEdge(edges[ei], cx, cy);
        backdrop = trueW[tile] - local;
      }
      const offset = edgeIndex.length;
      for (const ei of sets[tile]) edgeIndex.push(ei);
      tiles.push({ offset, count: sets[tile].length, backdrop });
    }
  }

  return { originX, originY, tileSize, tilesX, tilesY, tiles, edgeIndex };
}
