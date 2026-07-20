# ADR 0012 — Filters & effects

## Status

Accepted.

## Context

rendera composites isolated layers offscreen (ADR 0007) and now post-processes
them for clipping and masks (ADR 0011). The next capability on the same machinery
is **effects**: blur, drop shadow, and glow — the decorations every design tool
provides, and Phase 6 of the roadmap ("parametric op-lists evaluated at render —
never baked"). They must stay resolution-independent, like everything else.

## Decision

**Add non-destructive effects as an ordered `effects[]` list on any spatial node,
applied to the node's isolated layer at composite time.** v1 ships Gaussian blur,
drop shadow, and outer glow — all built on one separable-blur primitive.

1. **Model — a parametric op-list.** `SpatialNode.effects?: Effect[]`, a tagged
   union: `blur` (radius), `drop-shadow` (dx, dy, radius, colour), `outer-glow`
   (radius, colour). Lengths are in the node's **local space**, so an effect
   scales with zoom exactly like the vector content it decorates — nothing is
   baked at author time. This matches CSS `filter` / Photoshop layer effects and
   the roadmap's "op-lists evaluated at render".

2. **Emission — the outermost layer.** A node with effects is wrapped in an
   isolated group (it already isolates for clip/mask); the render list resolves
   each effect's local lengths to screen space (`ScreenEffect` — radius by the
   on-screen scale, the shadow offset by the matrix's linear part) and hangs them
   on the group. Effects are applied **after** clip/mask and **before**
   opacity/blend, so a shape is clipped/masked, then decorated, then faded.

3. **Compositor — separable blur + silhouette.** Two small full-screen shaders:
   a **separable Gaussian blur** (horizontal then vertical, `textureLoad` taps —
   out-of-bounds reads return 0, so premultiplied content fades to transparent at
   the edges, and the tap count is bounded so deep zoom stays affordable), and a
   **silhouette** pass (a tinted, optionally-offset copy of the layer's alpha).
   At group-pop the chain runs on the layer: `blur` filters it in place; a drop
   shadow / glow makes a silhouette (offset for the shadow), blurs it, and
   composites it *behind* the layer with the existing `over` blend. Screen-space
   lengths scale by the supersample factor to reach target pixels. Per-pass
   uniform slots are sized from a one-time command scan, like the blend params.

## Consequences

- Soft shadows, neon glows, and frosted blur all work, resolution-independently
  and re-editably — proven end to end (readback): blur bleeds soft coverage past
  the shape edge, a drop shadow casts a tinted offset silhouette only on the
  offset side (shape opaque on top), and an outer glow haloes symmetrically.
  Effects chain (glow then shadow) in author order. Showcased in the `Effects`
  story.
- Reuses the offscreen target pool and the `over` compositor; the only new GPU
  work is a bounded number of full-screen passes per effect, and effects force a
  node to isolate (as opacity/blend/clip/mask already do).
- Blur and luminance/colour all operate in linear light, consistent with the
  pipeline (physically correct light spreading, unlike sRGB-space blurs).
- Deliberate v1 limits, each a clean follow-up: no inner shadow/glow, no
  colour-adjustment effects (curves/levels/hue), and a very large blur clamps its
  tap count rather than downsampling (a mip/downsample path would keep huge radii
  cheap). An effect-result cache keyed by content + params is a later performance
  step (the roadmap's "effect DAG caching").
