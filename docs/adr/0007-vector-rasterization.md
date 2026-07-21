# ADR 0007 — Vector layers: analytic, resolution-independent rasterization

- **Status:** Accepted (spike-validated)
- **Date:** 2026-07-19
- **Relates to:** ADR 0002 (WebGPU backend), ADR 0003 (colour/precision),
  ADR 0004 (document model), ADR 0006 (transforms)

## Context

Raster layers soften once magnified past their native resolution — that is
physics, not a bug. The engine's crispness ambition therefore needs a *vector*
path: geometry that re-rasterizes razor-sharp at **any** zoom. The roadmap
(Phase 5) flagged the rasterization method as needing a spike before committing,
because GPU vector rasterization spans a wide quality/complexity range.

Decisions were taken with the product owner (grilled one at a time):

1. **First goal:** crisp *filled* shapes — solid-fill Bézier paths and primitive
   shapes. Strokes, gradients, boolean ops, SVG import, and text are later slices
   that compose onto a proven fill core.
2. **Rasterization:** **analytic coverage** — exact per-pixel coverage, giving
   resolution-independent anti-aliasing — over tessellation+SSAA or
   stencil+SSAA, whose AA is only as good as a fixed sample budget.
3. **Curves:** evaluated **exactly on the GPU** (no flattening to line segments),
   so no faceting ever appears, at any zoom.
4. **Cubics:** the model authors full SVG (line/quadratic/cubic), but the GPU
   rasterizes **quadratics exactly**; cubics are converted to quadratic segments
   to a sub-pixel tolerance (curve-accurate, never straight-line flattening).
   True exact cubics (Loop–Blinn cubic) were rejected as fragile.
5. **Model:** a single generic `path` node (subpaths of move/line/quadratic/
   cubic/close); primitives (rect, ellipse, rounded-rect, …) are helper
   constructors that emit paths.
6. **Sequencing:** spike-first — prove the GPU coverage maths, then build.

## Spike

A throwaway spike rendered one quadratic Bézier "curve triangle" with the
**Loop–Blinn** implicit test `f = u² − v` and **derivative-based coverage**
(`coverage = clamp(0.5 − f / |∇f|, 0, 1)`), reading back pixels at 128² and 256².

It confirmed:

- the interior fills and the exterior is empty;
- the boundary is anti-aliased; and, decisively,
- the anti-aliased rim scales with the shape's **perimeter (~2×)** when the
  resolution doubles, **not its area (~4×)** — the signature of a constant ~1px
  analytic edge. A fixed blur would scale with area. **Resolution-independent
  AA is therefore achievable on WebGPU.**

## Decision

Build vector fills on **exact-quadratic analytic coverage**:

1. **Model (`@rendera/core`):** a `path` node holding subpaths of exact segments
   plus a `fill` (reusing the tagged `Fill`) and fill rule (nonzero default,
   even-odd optional). Primitive helpers emit paths. Cubic→quadratic conversion
   and screen-space handling live in pure, tested core code.
2. **Coverage (`@rendera/webgpu`):** for each vector layer, evaluate exact
   per-pixel coverage from its quadratic + line segments (Loop–Blinn implicit for
   curve boundaries; exact signed-area/winding for straight edges), honouring the
   fill rule, into a coverage buffer. Coverage multiplies the layer's linear
   fill; the result composites through the existing backdrop-read compositor
   (ADR 0003) like any other layer — so blend modes, opacity, and group
   isolation apply unchanged.
3. **Colour:** fills are linear-light premultiplied; AA coverage modulates the
   premultiplied colour, so edges stay halo-free (ADR 0003).

## Consequences

- Vector shapes stay crisp at any zoom — the capability raster layers cannot
  provide, and the basis for future strokes, text (path/MSDF), and SVG import.
- Straight edges need analytic coverage too (the easy case); the spike only
  proved the curved case, which was the risk.
- Per-pixel per-segment evaluation is O(segments) without acceleration; a
  tile/bin acceleration structure is a later performance concern (consistent with
  ADR 0001: correctness first, optimize with benchmarks), alongside the tiled
  compositor.
- Cubic→quadratic conversion introduces a bounded, sub-pixel, curve-preserving
  approximation — not visible faceting.

## Follow-up: gradient paints

The tagged `Fill` (now `Paint`) extends beyond `solid` to `linear`, `radial`
(two-circle / focal), and `conic` gradients, decided as follows:

- **Analytic, not baked.** The gradient parameter `t` is computed per pixel in
  the same `PATH_SHADER` that already owns coverage — projecting onto the axis
  (linear), solving the two-circle cone equation (radial), or an `atan2` sweep
  (conic). No ramp texture: gradients stay band-free and resolution-independent
  at any zoom, and cost one small storage buffer of colour stops shared by all
  path draws (no per-gradient texture).
- **Authored in local space.** Gradient geometry lives in the shape's local
  space; the render list passes the `screen → local` affine and the shader maps
  each pixel back through it before evaluating `t`. A gradient therefore
  transforms *exactly* with its shape under any affine — rotate and it rotates,
  scale non-uniformly and it shears — matching Illustrator/Photoshop.
- **Interpolation space is a per-gradient choice.** Default is linear-light RGB
  (physically correct, matches the premultiplied pipeline); `oklab` is opt-in
  for perceptually-even hue ramps with no muddy midpoint (CSS Color 4 direction).
- **Full multi-stop + spread.** N stops at arbitrary offsets with `pad` /
  `repeat` / `reflect` spread, mirroring SVG/Canvas. Stops interpolate straight
  colour + alpha, then premultiply — halo-free like solid fills.
- **Fill and stroke share it.** A stroke's paint is a `Paint` too, so a single
  path can carry a gradient fill and an independent gradient stroke; both flow
  through the same analytic draw-path command.

## Follow-up: robust half-open winding

The per-pixel ray-crossing winding count must treat a scanline that lands
*exactly* on a shared on-curve vertex as **one** crossing, not two. Straight
edges (`windLine`) already use the standard half-open rule (lower-y endpoint
inclusive, upper-y exclusive), but the quadratic count originally included
*both* parameter endpoints (`t` in a closed `[0,1]`). When a device scanline
coincided with a vertex two adjacent segments share — common along a line of
text, where every glyph repeats the same x-height / baseline y — that crossing
was tallied twice, flipping the winding for the rest of the row and painting a
thin full-width line through the fill. It surfaced only at exact sub-pixel
coincidences, so it flickered in and out while panning.

The fix makes the quadratic use the **same** half-open convention as the line:
`windQuad` splits the curve at its y-extremum into monotonic pieces and counts
each piece against its *exact* endpoint y-values (`A.y`, the extremum, `C.y`) —
the shared endpoints are bit-identical to the neighbouring segment's, so the
`[lower, upper)` rule counts a shared vertex exactly once regardless of
floating-point root error. Horizontal tangents self-cancel (a scanline grazing
an extremum nets zero). Verified by a deterministic regression test: a shared
quad vertex placed exactly on a scene scanline no longer leaks fill past it.

## Follow-up: binned accelerator + directional edge culling

Per-pixel cost is O(edges in the pixel's row). The fill already bins edges into
**horizontal row bands** (8 device px), so a fragment only tests its own band —
and crucially the bins are by **Y, not X**: the winding is a horizontal
ray-crossing count, so a pixel genuinely needs *every* edge to its right in the
row (a naïve X-tiling would drop far-right edges and corrupt the winding).

The remaining waste is edges to the *left* of the pixel — they can neither cross
its rightward ray nor reach its ~1px AA rim, yet were still tested. So each
band's edges are now **sorted by max-X descending**, and the shader **breaks**
the loop at the first edge lying entirely left of the pixel (every later edge
does too). This culls the left-of-pixel edges per fragment with zero extra
storage and byte-identical output — ~1.9× on a dense wide scene (hundreds of
edges per band), and more the further right the pixel sits. The worst case (the
left edge of very wide content) is inherent to ray-crossing winding; a per-tile
*winding backdrop* for edges that fully span a tile — the piet-gpu coarse-raster
approach — is the next step to bound it, and is deferred as a heavier, winding-
correctness-sensitive change.

## Follow-up: per-cluster draw splitting

The binning above is by **Y only**, so a fragment tests every edge whose row-
band it shares — including edges far off-screen to its right, which the winding
ray still has to cross. A whole text run emitted as one draw-path therefore made
every on-screen fragment test *every* glyph's edges (all glyphs share a
baseline, so all land in the same few bands): at high zoom into one glyph the
GPU was doing ~N× the necessary work for N glyphs, the cause of the sluggish
high-zoom text.

`buildRenderList` now splits a vector shape into **bbox-connected clusters**
(union-find over subpath bounding boxes) and emits one draw-path per cluster. A
glyph and its counters (overlapping bboxes) stay one cluster; separate glyphs
become separate draws, each with a tight screen bbox and its *own* band table.
Off-screen clusters are culled by their bbox quad (zero fragments); on-screen
fragments only test their cluster's edges. A single connected shape stays one
draw (a no-op). This is cheap, general (helps any multi-part path — icons, dashed
runs, scattered marks), and correct because disjoint-bbox clusters have disjoint
fills, so compositing them separately equals filling them together. For a single
large connected shape (a magnified glyph, a big fill), the **per-tile winding
backdrop** below tiles the edges within that one cluster so its interior/exterior
skip the edge walk.

Complementary edge-count fix: stroking flattens curves to polylines and emitted
a full round-join **disc** at every vertex — including the ~1000 near-collinear
vertices a smooth glyph curve flattens into — so a single stroked letter carried
~17k edges (vs ~30 for its fill). The round join now emits only the outer **arc**
across the actual turn, and none at all where the turn is shallower than one
arc-segment (there the offset rectangles already meet within tolerance). That
drops a stroked glyph to ~3k edges (now dominated by the segment rectangles) with
no visible change — verified by a gap-free-circle readback and an edge-count
guard.

## Follow-up: distance-field round strokes

Offsetting curves into an outline (whether flattened rectangles or fitted
quadratics) is fundamentally fragile for thin strokes: a first attempt to offset
as quadratics shipped visible blobs on display text, because at a thin width the
offset pieces go bowtie / self-intersect and no per-piece winding fixes it. The
robust answer avoids offset geometry entirely.

A **round** stroke (round join, and round cap or a closed path — i.e. all text,
and most decorative strokes) is exactly *"the region within half-width of the
centerline"* — the Minkowski sum of the path with a disc. So instead of building
an outline, the render list emits the resolved-outline **centerline** edges plus
a half-width, and the path shader — which already computes the exact distance to
its nearest line/quadratic edge for the fill's AA rim — paints coverage where
that distance ≤ half, with the same ~1px analytic edge. Round joins and caps fall
out for free (distance to the polyline rounds every corner and end). The edges
are binned with the band pad widened to the half-width so a pixel finds every
edge within reach.

This is robust *by construction* — there is no offset geometry, so blobs,
bowties, self-intersection, and faceting are all impossible — and exact at any
zoom (distance to exact quadratics). It's also *cheaper*: the centerline is ~30
edges vs the ~3k of an offset outline. Overlap resolution still runs first
(distance to the raw centerline would re-stroke the interior seams). Verified by
readbacks: a stroked glyph shows no interior seam and, at high zoom, *every*
stroke pixel lies within half-width of the centerline (no blob can exist), and a
stroked circle's band is continuous and smooth.

**Miter/bevel via corner wedges.** A round join is a half-disc on a sharp
corner, so round-stroking a serif face beads every serif tip and terminal — and
a geometric miter stroker flattens, so it *spikes and facets* at deep zoom.
Instead, miter/bevel reuse the distance-field round body (crisp, round corners)
and *sharpen* each sharp corner with an exact wedge fill: `joinWedges` emits the
miter apex quad (or bevel triangle) at every corner whose turn exceeds a small
threshold, miter-limited so acute corners bevel instead of spiking. The wedges
are exact triangles (no flattening), so corners stay crisp at any zoom, and only
real corners cost a wedge (the round body covers smooth joins). Stroked serif
text is now sharp *and* crisp at any zoom.

**Butt/square caps on open paths — also the field.** Every stroke now renders
through the distance field (the flattened outline stroker is retired from the
render path), so open curves stay crisp at any zoom too. The two caps the round
field can't produce on its own are handled at the ends:

- *Butt* — the round capsule overshoots each open end by a half-disc. It's
  **clipped flat** by a per-terminus half-plane (the endpoint + outward tangent)
  carried on the centerline draw and applied in the fragment shader:
  `coverage ← min(coverage, clamp(0.5 − dot(p − end, tangent)))`, giving a ~1px
  analytic flat edge and sharp corners. The clip is gated to the cap disc
  (radius ≈ half) so it only trims *that* end's overshoot, never legitimate body
  elsewhere. Each open subpath is its own draw, so it carries at most two planes.
- *Square* — the flat 10px-style extension reaches *past* the round end, so it's
  **added**, not clipped: an exact corner rectangle per terminus (a fill polygon,
  like a join wedge) that subsumes the round half-disc and squares the corners.
- *Round* — free from the field.

A latent bug this replaced: the old open-path centerline closed every subpath
(the fill convention), so a round-capped open stroke drew a phantom edge straight
across its two ends. The centerline builder now leaves open subpaths open.

A subtlety this exposed: overlap resolution emits cubics, and converting a
*straight* cubic to a quadratic gives a degenerate quad (`control` on the chord,
so `A−2B+C ≈ 0`). `dQuad`'s Cardano solve divides by that and returns garbage —
which showed as a stroked rect's horizontal edges rendering in broken chunks.
`dQuad` now falls back to `dLine` when the quad is effectively straight.

## Follow-up: per-tile winding backdrop (`tiling.ts`)

The band loop walks edges for *every* covered fragment. When a shape is magnified,
its vast interior and the empty area around it are pure overhead — a pixel deep
inside a zoomed glyph tests the strip's edges only to conclude what a neighbour
already knew. The band table is replaced by a **16px tile grid** where each tile
carries its own edge list plus a **winding backdrop**, so a fragment reads the
carried-in winding and walks only its tile's edges:

    winding(pixel) = backdrop(tile) + windRay(pixel ; tile edges)

An empty tile (interior or exterior of the shape) has no edges — the fragment
just reads the backdrop and is done, solid or empty; that is the bulk of a
magnified shape.

The backdrop is defined exactly as

    backdrop = trueWinding(tileCorner) − windRay(tileCorner ; tile edges)

(`trueWinding` = winding over all edges, at the tile's top-left corner, from a
per-row scanline sweep). This identity holds for *any* tile edge set as long as
every edge NOT in it has the same rightward-ray crossing count at the corner and
at any pixel in the tile — i.e. every edge whose y-range **starts or ends inside
the tile's strip** (a "partial" edge) must be in the set. Edges that span the
whole strip or miss it contribute equally at corner and pixel, so the backdrop
absorbs them. So each tile's set is the edges within `reach` (needed for the
distance field anyway) plus the strip's partials. Adding extra edges is always
safe — the backdrop subtracts them back out.

A *simpler-looking* scheme was tried first and rejected: `backdrop =
winding(corner;all) − winding(corner;tileEdges)` with tile sets of only the
nearby edges. It misfills when an edge partially spans a tile's height and lies
outside the tile — it is counted neither in the list nor the backdrop (the
even-odd donut reproduces it). Requiring the strip's partials in the set is
exactly the fix. The whole thing is proven by a CPU winding-correctness test
(`tiling.spec.ts`) comparing `backdrop + per-tile winding` against a brute-force
sum over all edges, at a dense point grid, before it reaches the GPU.

Edges are binned into tiles by **walking each edge in ~tile-size steps** and
binning each short sub-segment's tight bbox — never the whole edge's bbox. That
matters: a long diagonal edge's bbox covers most of the grid, so bbox-binning put
it in ~every tile and the interior never went empty (a magnified `V` had 76% of
its tiles non-empty). Walking the edge is `O(length)`, bins only the tiles it
actually crosses, and drops that `V` to **4%** non-empty — so the interior/exterior
skip finally pays off for all content, curved glyphs included (a magnified glyph
now lists 3–14× fewer edges across its tiles).

## Follow-up: image & pattern fills

A fourth paint kind (`image`) samples a registered texture into the shape. Its
`transform` maps the unit image square [0,1]² to the paint target's **local**
space, so — exactly like gradient geometry — the image places, scales, rotates,
and shears with the shape under any affine; the backend bakes screen→UV
(`invert(transform) ∘ screenToLocal`) into the same `inv0/inv1` slots gradients
use. `spread` selects `pad` (a single placed image), `repeat` (a tiled pattern),
or `reflect` (mirror-tile). The fill fragment samples a group-2 texture at that
UV; a 1×1 dummy is bound for solid/gradient draws so the binding is always live.
The sampler is repeat-address (seamless tiling with no `fract` seam); `pad`
clamps to a half-texel inset so the edge texel doesn't wrap, and `reflect`
mirror-tiles in-shader. Because it rides the analytic fill, an image fill inherits
the same resolution-independent AA and compositing as every other paint, and a
stroke can be image-painted too.

Minified patterns are mip-filtered: the LOD comes **analytically** from the paint
affine — `inv0`'s columns are `d(uv)/d(device-px)`, scaled to output pixels
(÷ supersample) and texels (× texture size) — so there is no `dpdx` derivative
(hence no seam spike at the spread wrap and no uniform-control-flow constraint),
and the sampler trilinearly blends the mip chain `registerImage` already builds.
Sampling at LOD 0 aliased a shrunk pattern to a scatter of texels; the analytic
LOD averages it. (Magnification stays sharp — the LOD floors at 0.)
