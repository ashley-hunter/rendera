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
- ✅ **Model-inspector showcase:** a Storybook `SceneInspector` (in
  `@rendera/angular`) drawing the scene with a pure Canvas2D `drawScene`, plus
  drag-pan, wheel-zoom, click-to-select (`hitTest`), add/delete, and undo/redo —
  proving the model → view → input → history loop before any GPU work.
- ✅ **Selection model (object):** immutable `Selection` value (ids + primary) with
  pure ops, click/shift-click resolution, and document pruning. *(Pixel selection
  — marquee/lasso masks — and the `nodesInBounds` query are deferred to when a
  selection tool or culling needs them.)*
- ✅ **Input abstraction:** DOM-free `PointerInput` (phase, screen, buttons,
  modifiers, pressure, tilt, coalesced) + a `toPointerInput` DOM adapter in
  `@rendera/angular`. *(Tool state-machine framework deferred until multiple tools
  motivate it.)*
- ⬜ **Renderer interface (the seam):** deferred to Phase 2, designed against the
  WebGPU backend's real requirements rather than the inspector.

## Phase 2 — WebGPU compositor & colour pipeline (first pixels)  🔨  → `@rendera/webgpu`

The heart of the quality bar. This is the minimal-raster proof from ADR 0001.
Tested against a real device: headless Chromium runs WebGPU via **SwiftShader**,
so backend tests do **pixel readback** to assert colour correctness.

- ✅ **Device + colour-correct present:** device/adapter acquisition; canvas
  config (preferred format, premultiplied, Display-P3 colour space); an
  `rgba16float` linear scene target cleared to a linear colour and encoded to the
  display (sRGB transfer, shared by P3) with toggleable dither. A readback test
  asserts linear 0.5 → ~188/255. (ADR 0002, 0003)
- ⬜ **Fuller capability detection:** texture-format tiers, `maxTextureDimension2D`,
  subgroups; sRGB-canvas fallback path; wide-gamut primary matrices for coloured
  content.
- ⬜ **Blue-noise dither** (currently a hash-based placeholder).
- 🔨 **Scene quads through the camera:** a pure `buildRenderList(doc, camera)` in
  `@rendera/core` flattens drawable nodes into screen-space quads (debug colours);
  the renderer draws them instanced (premultiplied `over`) into the linear scene
  target. Readback-tested (a quad lands at the right pixels/colour). Shown on a
  real canvas via the `WebGpuScene` Storybook story (drag-pan, wheel-zoom, with
  graceful fallback when WebGPU is unavailable). *(Next: a **tiled compositor** —
  tiles, opacity, dirty-tile invalidation.)*
- ⬜ **Raster image layer** (tiled) + **pan/zoom/rotate viewport**: bicubic on
  magnify, trilinear-mip + anisotropic on minify.
- ⬜ **Showcase:** a crisp image on a pannable/zoomable/rotatable canvas.

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

## Phase 5 — Vector layer & tools  🔨  → `@rendera/vector`

- ✅ **Rasterization decided (ADR 0007):** exact-quadratic **analytic coverage**
  (resolution-independent AA), GPU-exact curves (no flattening), cubics converted
  to quadratics to sub-pixel tolerance, generic `path` node. A spike proved the
  Loop–Blinn implicit + derivative-coverage method on WebGPU: the AA rim scales
  with perimeter (~2×), not area (~4×) — a constant ~1px analytic edge.
- ✅ **Path/shape model:** generic `path` node (line/quadratic/cubic/close) with a
  tagged paint (`solid` + gradients) + winding rule, primitive helpers (rect,
  ellipse, rounded-rect, polygon), cubic→quadratic conversion, hit-testing.
- ✅ **Analytic fill rasterizer:** per-pixel winding (nonzero / even-odd) + exact
  distance to line/quadratic edges for a resolution-independent ~1px AA rim,
  modulating a linear fill, composited through the backdrop-read compositor (so
  blend modes / opacity / groups apply). Readback-verified; `Vectors` story stays
  razor-sharp under deep zoom.
- ✅ **Strokes:** outline conversion — segment quads + miter/round/bevel joins +
  butt/round/square caps, unioned via nonzero and filled by the analytic
  rasterizer (so strokes inherit resolution-independent AA). A path can carry a
  fill and a stroke. *(Variable width and dashes are follow-ups.)*
- ✅ **Gradients:** analytic linear / radial (two-circle, focal) / conic paints,
  evaluated per-pixel in the path shader (no ramp texture) so they stay band-free
  and resolution-independent at any zoom. Multi-stop, `pad`/`repeat`/`reflect`
  spread, and per-gradient linear-light **or OKLab** interpolation. Authored in
  local space, so a gradient transforms exactly with its shape; fills and strokes
  both carry it. (ADR 0007 follow-up.) *(Boolean ops still to come.)*
- ✅ **Text (ADR 0008):** real **HarfBuzz** (WASM) shaping — ligatures, kerning,
  GPOS/GSUB, bidi (UAX #9) + script itemization (UAX #24) — with glyph **outlines**
  fed through the analytic fill, so type is resolution-independent and paints with
  solid colour, gradients, and strokes like any vector. A `text` node + font
  loading + layout live in DOM-free `@rendera/core` (wasm lazy-loaded). *(MSDF
  atlas for dense small text, line wrapping, and colour glyphs are follow-ups.)*
- ⬜ **Boolean ops** (union / intersect / difference on paths).

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
- **Deferred kernel performance** (correctness-neutral, API-transparent — do
  together, benchmark-driven, alongside the render loop and culling/selection):
  a children/parent index (today `getChildren` scans the whole node map), a
  dirty-tracked world-matrix cache, and a spatial broad-phase (quadtree/R-tree)
  for hit-testing and culling. Hit-test/bounds already thread the parent world
  matrix through recursion, so the O(depth) re-walk is gone.
- **Mobile-first input:** pointer/pressure/tilt/gestures from Phase 1.
- **Storybook showcases every capability** (a hard project requirement).
- **Multiplayer-readiness preserved** (flat store, scoped diff undo, fractional
  indexing) but not built. (ADR 0004)
- **Quality gates:** correctness rules from ADR 0003 enforced in review; visual
  regression snapshots as backends mature.
