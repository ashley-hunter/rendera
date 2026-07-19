# ADR 0002 — Rendering backend: WebGPU-only, pluggable seam for fallbacks

- **Status:** Accepted
- **Date:** 2026-07-19
- **Relates to:** ADR 0001 (foundational engine first), ADR 0003 (colour pipeline)

## Context

Rendera targets Photoshop/Illustrator-class quality: non-destructive effect
stacks, many-layer compositing with blend modes, and analytic-quality vector
rendering, fluid on desktop and mobile. Research into how the serious engines are
built (Figma, Skia's next-gen Graphite backend, Rive, Vello/piet-gpu) shows they
all sit on the **compute-capable modern GPU stack**.

The decisive fact: **WebGL2 has no compute pipeline.** Vello-class path
rasterization, GPU effect/filter stacks, culling, and prefix-sum-based
parallelism all require compute shaders, storage buffers/textures, and workgroup
shared memory — none of which WebGL2 exposes. A WebGL2 renderer is therefore
permanently a lower-quality, lower-capability ceiling, not a peer.

Browser reach in 2026: WebGPU is ~85% (all desktop engines; iOS/iPadOS 26 via
Metal; Android 12+ on Qualcomm/ARM), versus ~100% for WebGL2. The project's
stated priority is doing things the best way for the long term, not maximising
immediate reach.

## Decision

Build v1 on **WebGPU only**, behind a **narrow, pluggable rendering-backend
seam**. The engine core is renderer-agnostic; the WebGPU backend is one
implementation of a small interface (roughly `render(scene, camera,
dirtyRegions)`, optional `pick()`, and device-pixel-ratio handling).

A reduced-capability fallback (WebGL2, Canvas2D) and a headless/SVG test backend
may be added later **without touching the core**, precisely because the seam
exists from day one. We do not build a WebGL2 fallback now — maintaining a second
backend would double rendering effort and pressure the core toward WebGL2's
limits.

## Consequences

- Users on browsers without WebGPU cannot run the app until a fallback backend is
  written. We accept this for v1; we detect WebGPU support and show a clear,
  graceful message rather than a broken canvas.
- Every optional WebGPU capability (Display-P3, HDR tone-mapping, texture-format
  tiers, `maxTextureDimension2D`, subgroups) must be **feature-detected** with a
  fallback path — especially on Android/mobile, where support and limits vary by
  GPU. Design to WebGPU **default limits** (e.g. `maxTextureDimension2D` = 8192)
  as the portability contract.
- The rendering seam is itself a load-bearing, hard-to-reverse decision: the core
  must never import GPU/DOM APIs, so it stays unit-testable headlessly and open to
  future backends. Enforce the dependency direction `angular → renderer → core`
  with lint boundaries.
- The renderer is an **eventually-consistent projection** of the authoritative
  CPU model: model edits commit synchronously; GPU work (composite, filters) runs
  downstream off dirty regions and may be batched, debounced, moved to a
  worker/OffscreenCanvas, and cancelled when superseded. Undo never awaits the GPU.

## Notes / references

- Compute is the dividing line: WebGL2 cannot express the effect/compositing/
  vector-rasterization work this engine needs.
- Prior art on the same bet: Figma (migrated renderer to WebGPU), Skia Graphite
  (Dawn/WebGPU-oriented), Rive Renderer, Vello/piet-gpu.
