# Rendera — Build Roadmap

> The order we build in, and why. Derived from the ADRs in `docs/adr/`. Each
> phase ends with something **showcased in Storybook** and green in CI. The guiding
> rule (ADR 0001): fundamentals first — later phases compose onto a proven core,
> nothing is built twice.
>
> Sequencing note: raster rendering is placed before vector because the
> proof-of-core is a minimal raster layer that exercises the whole compositor and
> colour pipeline. This order is adjustable — vector-first is a viable swap after
> Phase 2.

## Status legend
✅ done · 🔨 in progress · ⬜ not started

---

## Phase 0 — Workspace & delivery harness  ✅ (mostly)

Foundation so every later phase ships safely.

- ✅ Nx workspace (pnpm, `@rendera/*` scope), `@rendera/core` + `@rendera/angular`.
- ✅ Storybook for the Angular lib; CI (lint/test/build); Storybook → GitHub Pages on `main`.
- ⬜ Enforce dependency boundaries (Nx module boundaries / ESLint): `@rendera/core`
  may not import DOM/GPU/framework packages; direction is `angular → renderer → core`.
- ⬜ Headless test conventions for the core (Vitest, no canvas).

## Phase 1 — Engine kernel (headless, no pixels)  🔨  → `@rendera/core`

The authoritative model and all the math, fully unit-tested without a canvas.

- ✅ **Document model:** flat `Map<NodeId, Node>` record store; node-type + util
  registries; `parentId` + fractional index for z-order; versioned JSON
  serialization. (ADR 0004) *(migrations pending.)*
- ✅ **History engine:** change-recording diff stream over the store; transaction
  batching, coalescing by key, redo invalidation, and `withoutHistory`. (ADR 0004)
- ✅ **Transform math:** `vec2`, `Mat2D` affine (compose/invert/point+vector),
  decomposed **TRS(+skew)** transform with derived matrix, and AABB `bounds`
  (union/contains/intersect/transform). (ADR 0006)
- ✅ **Spatial model:** `SpatialNode` carries a transform; world-matrix
  composition, world bounds (leaf rect / container union), and geometric
  hit-testing (top-most, z-ordered) via util-owned local geometry.
- ✅ **Camera & coordinate spaces:** origin-anchored pan/zoom/rotation camera;
  `worldToScreen`/`screenToWorld` + matrices, visible-world-bounds, and the
  anchored ops `panBy`/`zoomAround`/`rotateAround`/`fitBounds`. (DPR deferred to
  the backend.)
- ⬜ **Selection, spatial index, input (`PointerInput`) + tools.**
- **Camera & coordinate spaces:** screen/world/local; `screenToWorld` /
  `worldToScreen` / viewport bounds (DPR deferred to the backend).
- **Selection model:** object selection (node ids) + a pixel-selection region type.
- **Spatial index** (quadtree/R-tree) for culling + broad-phase hit testing.
- **Hit testing:** geometric, via node utils (authoritative, headless).
- **Input abstraction:** `PointerInput` (type, world/screen, pressure, tilt,
  coalesced samples); tools as **state machines**; gesture recognizer (pan/zoom/rotate).
- **Renderer interface:** the seam (`render(scene, camera, dirty)`, optional
  `pick()`), with no implementation yet.
- **Showcase:** a headless "model inspector" story (bounds/selection/hit-test
  visualised with simple DOM/SVG) proving the model before any GPU work.

## Phase 2 — WebGPU compositor & colour pipeline (first pixels)  ⬜  → `@rendera/webgpu`

The heart of the quality bar. This is the minimal-raster proof from ADR 0001.

- **Device/context:** capability detection (Display-P3, texture-format tiers,
  `maxTextureDimension2D`, subgroups); preferred format; premultiplied alpha;
  Display-P3 canvas with sRGB fallback. (ADR 0002, 0003)
- **Tiled compositor:** `rgba16float` linear-premultiplied tiles; layer-stack
  traversal; opacity; Porter–Duff `over`; dirty-tile invalidation; static vs
  interactive surface split.
- **Colour pipeline:** decode-to-linear-P3 on import; present pass = encode once
  + **blue-noise dither**; correct sRGB/P3 output. (ADR 0003)
- **Raster image layer** (tiled) + **pan/zoom/rotate viewport**: bicubic on
  magnify, trilinear-mip + anisotropic on minify (mips built linear-premultiplied).
- **Showcase:** a crisp image on a pannable/zoomable/rotatable canvas — the first
  visible quality bar, on desktop and mobile.

## Phase 3 — Raster rendering & brush primitives  ⬜  → `@rendera/raster`

- **Brush/stroke engine:** stamp/spacing model; per-stroke `rgba16float` buffer;
  sub-pixel dabs; `over`-accumulation in linear premultiplied; commit to layer
  tiles; **tile-snapshot undo**; pressure/tilt dynamics (size/opacity/flow);
  AA-off (pixel) mode.
- **Layers:** create / reorder (fractional index) / opacity / visibility / lock.
- **Blend modes:** separable + non-separable (W3C Compositing-1) in the
  compositor; per-document "blend in gamma space" (legacy) toggle.
- **Showcase:** brush strokes across layers and blend modes.

## Phase 4 — Selection, transforms, groups  ⬜  → `@rendera/core` + `@rendera/webgpu`

- **Object selection + gizmos:** resize/rotate/skew handles derived from world
  bounds; move/rotate/scale/skew via TRS; multi-select group transform; pivot.
- **Groups / frames**; **masks** (raster + vector mask nodes); clipping.
- **Pixel selection tools:** marquee / lasso / magic-wand → region mask
  constraining raster ops ("marching ants").
- **Showcase:** transform-handles and selection demos (desktop + touch gestures).

## Phase 5 — Vector layer & tools  ⬜  → `@rendera/vector`

- **Path/shape model** (Bézier); fills / strokes / gradients (interpolated in
  linear/OKLab); boolean ops.
- **Analytic-quality vector rasterization** into the tile grid — evaluate a
  compute-based coverage path vs a triangle-patch + coverage-accumulation pass
  (tessellation is the known WebGL2-fallback shape). Decide via a spike; record an ADR.
- **Text:** MSDF atlas for zoomable UI text + a high-quality path for large/display type.
- **Showcase:** resolution-independent vector drawing that stays crisp at any zoom.

## Phase 6 — Effects & non-destructive stack  ⬜  → `@rendera/effects`

- **Adjustment layers** (curves, levels, hue/sat) and **layer effects** (blur,
  drop shadow, glow) as **parametric op-lists evaluated at render** — never baked.
- **Effect DAG caching** keyed by content hash + dirty flags; correct **group
  isolation** for non-separable blends.
- **Showcase:** a non-destructive effect stack that stays fully re-editable.

## Phase 7 — Import / export & document format  ⬜  → `@rendera/io`

- **Import:** PNG (8/16-bit), JPEG (4:4:4), WebP, AVIF, **SVG as vector**; honour
  embedded ICC / assume sRGB; matrix known profiles into working space.
- **Export:** tag output profile always; tiled export beyond max texture size;
  quality controls (chroma subsampling, bit depth).
- **Document format:** versioned zip container (manifest + per-layer tiles +
  vector geometry + document colour space/precision). Round-trips losslessly.
- **Showcase:** import → edit → export, and save/reopen a `.rendera` document.

## Phase 8 — Animation & rigging  ⬜  → `@rendera/animation`

Unblocked by the model (ADR 0004/0006); built last.

- **Timelines / keyframes / easing** writing to `(nodeId, propertyPath)` channels.
- **State machines + inputs** blending timelines.
- **Rigging:** bone hierarchy (a node's transform parent may be a bone), slots /
  attachments / skins, mesh vertex-weight skinning, IK.
- **Showcase:** a keyframed animation and a simple bone-rigged, skinned character.

---

## Cross-cutting (every phase)

- **Performance:** tiling, dirty-rect, viewport culling, OffscreenCanvas + worker
  rendering, GPU-memory budgets, WebGPU render bundles. Maintain a real mobile
  **device matrix** (Adreno / Mali / Apple) — GPU/driver variance is a known risk.
- **Mobile-first input:** pointer/pressure/tilt/gestures from Phase 1.
- **Storybook showcases every capability** (a hard project requirement).
- **Multiplayer-readiness preserved** (flat store, scoped diff undo, fractional
  indexing) but not built. (ADR 0004)
- **Quality gates:** correctness rules from ADR 0003 enforced in review; visual
  regression snapshots as backends mature.
