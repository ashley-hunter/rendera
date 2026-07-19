# ADR 0003 — Colour & precision pipeline: linear-light, premultiplied, fp16, wide-gamut P3

- **Status:** Accepted
- **Date:** 2026-07-19
- **Relates to:** ADR 0002 (WebGPU backend)

## Context

"Photoshop crispness" is, more than anything else, a colour-and-precision
discipline. Research across NVIDIA GPU Gems, the W3C Compositing spec, Krita's
colour docs, and practitioner write-ups converges on a small set of
non-negotiable rules. Getting these wrong produces the classic amateur symptoms:
muddy 50/50 blends, dark halos around blurred/soft edges, banding in shadows and
gradients, and colour shifts on resize.

The chosen ambition (decided with the product owner) is **wide-gamut from day
one**: a linear Display-P3 working space and Display-P3 canvas output, so colours
from modern wide-gamut displays and assets are not clipped during editing.

## Decision

The engine composites in a **scene-linear, premultiplied-alpha, half-float,
Display-P3-primaries** working space, and converts to the display encoding
exactly once at output.

Concrete pipeline:

1. **Working space:** linear light, **Display-P3 primaries**, stored as
   **`rgba16float`**, **premultiplied** alpha. All layer targets and the
   composite accumulator use this format.
2. **Import / decode:** decode every source to the working space once — apply the
   source transfer function (sRGB/P3 EOTF) and, if primaries differ (e.g. an sRGB
   asset), apply the 3×3 primary matrix to bring it into linear P3. Untagged
   content is assumed sRGB; honour embedded ICC/`cICP` where present.
3. **Composite:** Porter–Duff `over` on premultiplied linear values. Blend modes
   implemented per the W3C Compositing-1 formulas (separable + the non-separable
   hue/saturation/colour/luminosity trio), un-premultiplying only transiently
   inside the blend math.
4. **Resample for view:** magnify with in-shader **bicubic (Catmull-Rom)**;
   minify with **trilinear mipmaps + anisotropic** filtering; nearest only for an
   explicit pixel-grid view. Mip chains are generated in **linear premultiplied**
   space. High-quality export resample uses **Lanczos-3** in linear float.
5. **Present:** convert working-linear-P3 → the display encoding once, add
   **blue-noise dither** before quantising, and output to a **Display-P3 canvas**
   when the display supports it (`matchMedia('(color-gamut: p3)')`), else sRGB.

## Load-bearing rules to enforce everywhere

- Decode to linear on import; **blend/filter/resample/mip in linear premultiplied
  half-float**; encode to display space **exactly once** at output.
- **Alpha is always linear** (coverage), never gamma-encoded.
- **Dither only at the final quantisation** (blue-noise), never mid-pipeline.
- **Always tag exported files** with their colour profile (sRGB or Display-P3).
- **Feature-detect** the Display-P3 canvas path and fall back to sRGB output.
- Provide a per-document **"blend in gamma space" toggle** for bit-exact
  Photoshop-legacy blend-mode matching (default is physically-correct linear).

## Consequences

- More colour-management surface up front than an sRGB-only v1: sRGB assets must
  be matrixed into P3 on import, colour pickers must speak the working space, and
  the Display-P3 output path must be built now (with an sRGB fallback).
- `rgba16float` everywhere doubles memory versus 8-bit — a real mobile constraint.
  Mitigate by keeping 8-bit source layers in `rgba8unorm-srgb` and materialising
  `rgba16float` only for active composite regions/tiles (see the tiling ADR, TBD).
- HDR (`rgba16float` canvas + `toneMapping: "extended"`) is deferred, but the
  float pipeline is already HDR-ready — no rework to add it later.
- ICC handling is pragmatic: recognise sRGB / Display-P3 / common matrix-TRC
  profiles via built-in matrices; defer a WASM Little-CMS path for exotic/CMYK
  profiles; do not build a full colour-management system (OpenColorIO) now.
