# ADR 0013 — Adjustment layers

## Status

Accepted.

## Context

ADR 0012 added spatial effects (blur, drop shadow, glow) as a non-destructive
`effects[]` op-list on any node, and explicitly deferred **colour adjustments**.
Those adjustments — brightness/contrast, hue/saturation, levels/curves — are the
other half of a "layer effects" stack, and Phase 6's stated goal
("parametric op-lists evaluated at render — never baked"). The machinery is
already there; this is about defining the adjustment set and where it runs.

## Decision

**Add colour adjustments as further `Effect` variants in the same `effects[]`
list, each a per-pixel colour transform applied in linear light.** v1 ships
brightness/contrast, hue/saturation (+lightness), and levels.

1. **Model — more effect variants, unitless.**
   - `brightness-contrast` — a linear offset plus a contrast scale about
     mid-grey.
   - `hue-saturation` — a luminance-preserving hue rotation (degrees), a
     saturation scale (−1 = greyscale), and a lightness mix toward black/white.
   - `levels` — remap `[inBlack, inWhite]` through a `gamma` curve into
     `[outBlack, outWhite]`, per channel.

   Unlike the spatial effects, these carry no lengths, so they pass through to
   the render list's `ScreenEffect` unchanged (nothing to scale by zoom) and slot
   into the existing effect chain and ordering.

2. **Compositor — one colour-transform pass, in linear light.** A single
   full-screen shader (`mode` + params) un-premultiplies the layer to straight
   colour, applies the selected transform, and re-premultiplies (alpha
   untouched). Hue rotation uses the SVG `feColorMatrix` luminance-preserving
   matrix. Everything runs in the pipeline's linear-light space — physically
   consistent, and the natural place given the `rgba16float` targets. Per-op
   uniform slots are sized from the same command scan as blur/silhouette.

## Consequences

- A node's effect list can now mix decoration and colour grading
  (glow → desaturate → levels), all re-editable and evaluated at render — proven
  end to end (readback): brightness lifts the layer, contrast splits
  bright/dark, saturation −1 greys a colour while preserving luminance, hue 120°
  moves red toward green, levels gamma brightens mid-tones, and an in-black of
  0.5 crushes mid-grey to black. Showcased in the `Adjustments` story.
- Reuses the offscreen-layer machinery entirely; the only new GPU work is one
  full-screen pass per adjustment.
- Adjustments run in **linear light**, so a levels `gamma` is a linear-space
  gamma — physically consistent with the rest of the engine, and a deliberate
  difference from tools that grade in a gamma-encoded working space.
- Deliberate v1 limits, each a clean follow-up: no arbitrary **curves** (a spline
  LUT — the general form of levels), no per-channel levels/curves, and no
  black-and-white/colour-balance/selective-colour graders. An effect-result cache
  (ADR 0012) covers these too once added.
