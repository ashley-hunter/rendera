# Rendera — Project Context

> Living domain model and shared language for Rendera. Kept concise and current.
> Decisions are recorded as ADRs in `docs/adr/`; this file captures the overview,
> principles, and glossary that make the ADRs and code readable.

## What Rendera is

Rendera is a generic, framework-agnostic **GPU canvas rendering engine** — a
library, not an application. It provides the building blocks for high-quality
interactive graphics of any kind: a document/scene model, GPU compositing, layers
and groups, transforms, selection, undo/redo, raster and vector rendering,
effects, and (in time) animation and rigging. Consumers build whatever they need
on top; **this repository ships the library only — no end-user application.**

Two north stars:

1. **Quality** — reference-quality, crisp output. Correct colour and precision
   are the foundation, not a polish step.
2. **Fundamentals first** — do things the best way for the long term, not the
   fast way. Breadth of features is layered onto a proven core.

## Scope & shape

- Framework-agnostic **engine core** in `@rendera/core` (pure TypeScript,
  **no DOM, no GPU, no Angular imports**), consumed by thin UI wrappers.
- `@rendera/angular` is the first wrapper (a thin adapter, not logic).
- Domain-specific capabilities may later live in additional `@rendera/*` libs.
- Targets **desktop and mobile** browsers. Everything is showcased in Storybook.
- Supports **raster and vector** content, import/edit/export, in one document.

## Architecture principles (the load-bearing ones)

- **Model is authoritative; rendering is a pure projection of it.** The core owns
  a serializable document model; the renderer draws it and never holds truth.
- **Strict dependency direction:** `angular → renderer → core`. The core imports
  nothing framework- or GPU-specific and is unit-testable headlessly.
- **Pluggable rendering backend** behind a narrow seam (ADR 0002). WebGPU is the
  only backend for v1; a headless/fallback backend can be added without core
  changes.
- **Colour correctness is mandatory** (ADR 0003): composite in scene-linear,
  premultiplied, `rgba16float`, Display-P3; encode to display exactly once with
  dither.
- **Serializable from day one.** The document/file format is the most permanent
  contract; it carries a schema version and migrations.

## Decision log (ADRs)

| ADR | Decision |
| --- | --- |
| [0001](docs/adr/0001-build-strategy-foundational-engine-first.md) | Build the foundational engine first; features layer on top |
| [0002](docs/adr/0002-rendering-backend-webgpu-only.md) | Rendering backend: WebGPU-only, pluggable seam for later fallbacks |
| [0003](docs/adr/0003-colour-and-precision-pipeline.md) | Colour pipeline: linear-light, premultiplied, fp16, wide-gamut Display-P3 |
| [0004](docs/adr/0004-document-model-and-history.md) | Flat ID-keyed record store; diff/mark undo; multiplayer-ready, not built |
| [0005](docs/adr/0005-package-architecture.md) | Package architecture: `core` kernel + `webgpu` backend + `angular` wrapper; feature libs as built |
| [0006](docs/adr/0006-transform-representation.md) | Transforms stored as decomposed TRS(+skew), affine matrix derived |

**Build order:** see [`docs/ROADMAP.md`](docs/ROADMAP.md) for the phased plan.

## Glossary

Terms are grouped; definitions are deliberately short. Add terms as they earn
their place in the code and conversations.

### Colour & rendering
- **Scene-linear / linear light** — colour values proportional to light, where
  blending, blur, resampling, AA, and mip generation are mathematically correct.
- **sRGB / transfer function (OETF/EOTF)** — the non-linear encoding of stored
  pixels; decoded to linear on import, re-applied once at output.
- **Premultiplied (associated) alpha** — RGB stored already multiplied by alpha;
  required for halo-free filtering and Porter–Duff `over` compositing.
- **Working space** — where pixels live and blends happen: linear Display-P3,
  `rgba16float`, premultiplied.
- **Display-P3 / wide gamut** — the wide colour gamut used as the working and
  output space; sRGB assets are matrixed into it on import.
- **Blend mode** — a per-pixel combination function (multiply, screen, overlay …
  and the non-separable hue/saturation/colour/luminosity). Defined by W3C
  Compositing-1.
- **Dither (blue-noise)** — noise added just before final 8-bit quantisation to
  hide gradient banding.
- **Mipmap / trilinear / anisotropic** — pre-filtered image pyramid and sampling
  modes that keep minified (zoomed-out) and rotated views free of aliasing.
- **Tile-based compositor** — the canvas is partitioned into tiles composited
  independently, enabling dirty-rect updates and bounded memory.

### Document model
- **Record store / LayerTree** — the document as a flat, ID-keyed map of
  serializable node records; hierarchy encoded as `parentId` + an order key.
- **Node** — a serializable record (document, page, group/frame, vector path,
  raster layer, text, image, adjustment, mask …). Data only.
- **Node util** — per-type behaviour (bounds, geometry, hit-test, serialize)
  looked up by node `type`; behaviour is never stored on the record.
- **Fractional index (LexoRank)** — string sort key for sibling z-order allowing
  O(1), conflict-friendly reordering.
- **Non-destructive editing** — edits stored as re-editable parameters
  (adjustment layers, masks, effect stacks), never baked into pixels.
- **Adjustment layer** — a node applying a parametric colour/tonal op to layers
  beneath it, with no pixels of its own.

### Interaction
- **Object selection vs pixel selection** — a set of node ids, versus a
  raster/vector region (marquee/lasso/magic-wand) constraining raster ops.
- **Affine transform / TRS / pivot** — a 6-value matrix combining translate,
  rotate, scale, skew; **TRS = the decomposed, animatable channels** kept as the
  source of truth, matrix derived; pivot = transform origin.
- **Gizmo / handles** — the resize/rotate/skew controls derived from a
  selection's world-space bounds.
- **Hit testing vs GPU picking** — CPU point-in-shape test (authoritative, in
  core) versus an offscreen ID-coloured buffer read back for pixel-perfect picks.
- **PointerInput** — the engine's unified, DOM-free input event (type, world &
  screen point, pressure, tilt, coalesced samples); tools are state machines over
  it.
- **Camera / screen vs world space / devicePixelRatio** — the per-viewer viewport
  transform and the coordinate stack; DPR handling lives in the backend.

### Animation (future, kept unblocked)
- **Timeline / keyframe / easing** — property animation channels over time.
- **State machine / input** — higher-level control blending timelines via
  boolean/number/trigger inputs.
- **Bone / slot / attachment / skin / vertex weight / IK** — skeletal rigging:
  bone hierarchy, draw-order slots, drawables, swappable sets, mesh-skinning
  weights, inverse kinematics.
