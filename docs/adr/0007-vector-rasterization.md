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
