import {
  buildRenderList,
  createCamera,
  createSequentialIdFactory,
  SceneDocument,
  type Path,
  type PathNode,
  type StrokeCap,
} from '@rendera/core';
import { WebGpuRenderer, type ReadbackResult } from './renderer';

const W = 400;
const H = 200;

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}
function sum(rb: ReadbackResult, x: number, y: number): number {
  const o = y * rb.bytesPerRow + x * 4;
  return rb.data[o] + rb.data[o + 1] + rb.data[o + 2];
}
const lit = (rb: ReadbackResult, x: number, y: number): boolean => sum(rb, x, y) > 60;
const bare = (rb: ReadbackResult, x: number, y: number): boolean => sum(rb, x, y) < 30;

async function renderStroke(path: Path, cap: StrokeCap): Promise<ReadbackResult> {
  const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
  doc.insert<PathNode>({
    type: 'path',
    name: 's',
    path,
    fill: undefined, // stroke only
    stroke: { paint: { type: 'solid', color: { r: 0.9, g: 0.3, b: 0.2, a: 1 } }, width: 20, cap },
  });
  const renderer = await WebGpuRenderer.create(makeCanvas(), { colorSpace: 'srgb', dither: false });
  renderer.setClearColor({ r: 0, g: 0, b: 0, a: 1 });
  renderer.setRenderList(buildRenderList(doc, createCamera()));
  const rb = await renderer.readback();
  renderer.destroy();
  return rb;
}

// An open horizontal line, centreline y=100 from x=100 to x=300, stroked width 20
// (half = 10). All three caps share the distance-field body; they differ only at
// the ends: butt stops flat AT the endpoint, round bulges a semicircle to x=310,
// square fills a flat 10px extension (corners and all) to x=310.
function hline(): Path {
  return {
    subpaths: [{ start: { x: 100, y: 100 }, closed: false, segments: [{ type: 'line', to: { x: 300, y: 100 } }] }],
  };
}

// An open "V": two arms meeting at an apex, ends both at y=40. A regression guard
// for the phantom closing edge — the old open-path centerline closed the subpath,
// stroking a line straight across the top between the two open ends.
function vPath(): Path {
  return {
    subpaths: [
      {
        start: { x: 120, y: 40 },
        closed: false,
        segments: [
          { type: 'line', to: { x: 200, y: 140 } },
          { type: 'line', to: { x: 280, y: 40 } },
        ],
      },
    ],
  };
}

describe('distance-field stroke caps', () => {
  it('butt caps stop flat at the endpoint (no round overshoot)', async () => {
    const rb = await renderStroke(hline(), 'butt');
    expect(lit(rb, 200, 100)).toBe(true); // body is stroked
    expect(lit(rb, 294, 100)).toBe(true); // right up to the endpoint
    // 6px past the endpoint: a round cap would still be lit here (reaches x=310),
    // a butt cap must be bare.
    expect(bare(rb, 306, 100)).toBe(true);
  });

  it('round caps bulge a semicircle past the endpoint', async () => {
    const rb = await renderStroke(hline(), 'round');
    expect(lit(rb, 306, 100)).toBe(true); // inside the semicircle (reaches x=310)
    expect(bare(rb, 316, 100)).toBe(true); // beyond it
    // The rounded end has no square corner: (308,108) is outside the disc.
    expect(bare(rb, 308, 108)).toBe(true);
  });

  it('square caps fill the flat corner a round cap leaves bare', async () => {
    const rb = await renderStroke(hline(), 'square');
    expect(lit(rb, 306, 100)).toBe(true); // the flat 10px extension
    // The far square corner (x∈[300,310], y∈[90,110]) — a round cap can't reach it.
    expect(lit(rb, 308, 108)).toBe(true);
    // But the extension still stops at x=310.
    expect(bare(rb, 316, 100)).toBe(true);
  });

  it('open paths draw no phantom edge closing the two ends (round caps)', async () => {
    const rb = await renderStroke(vPath(), 'round');
    expect(lit(rb, 160, 90)).toBe(true); // the left arm is stroked (sanity)
    // The chord between the two open ends (y=40) must be empty — a phantom closing
    // edge would stroke a line straight across here.
    expect(bare(rb, 200, 40)).toBe(true);
  });
});
