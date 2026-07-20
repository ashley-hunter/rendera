# ADR 0011 — Clipping & masks

## Status

Accepted.

## Context

rendera has a full vector stack and a backdrop-read compositor that already
renders isolated groups into offscreen layers (ADR 0007, the compositing model).
The next compositing primitive designers expect is **clipping and masking**:
restrict a layer to a region, or modulate its alpha by another layer's content —
the basis of vignettes, knockout/soft-edged reveals, image-in-shape, and framed
groups. It is also the SVG-import follow-up flagged in ADR 0010 (`<clipPath>` /
`<mask>`).

The design questions were the model surface (how a clip/mask attaches to a node),
the channel a soft mask reads, and how far v1 goes.

## Decision

**Add clip-path and soft masks as first-class compositing, sharing one
offscreen-coverage mechanism, and wire them into SVG import.**

1. **Model — properties + a referenced mask node.** `SpatialNode` gains two
   optional fields:
   - `clip?: ClipPath` — a vector region (`{ path, rule }`) in the node's local
     space; the node (and its subtree) renders only inside it, antialiased.
   - `mask?: MaskRef` — `{ maskId, type? }` referencing a new **`mask` node**: a
     container whose children render as a coverage source and are never drawn on
     their own. `type` is `'luminance'` (default, SVG's) or `'alpha'`.

   This mirrors CSS/SVG's two distinct properties (`clip-path` vs `mask`), reuses
   the container precedent (like the boolean node), and imports 1:1 from SVG. A
   geometric clip stays a cheap property (no separate subtree); a soft mask is a
   reusable, referenceable node.

2. **One mechanism — offscreen coverage multiply.** A clipped/masked node is
   wrapped in an isolated group (via `push-mask`/`pop-mask` brackets and a `mask`
   flag on `push-group`). The compositor renders the coverage source into a
   target, then at group-pop multiplies the layer's premultiplied RGBA by the
   coverage — luminance of the premultiplied RGB (which equals SVG's
   luminance·alpha), or the alpha channel — before it composites onto the
   backdrop. **A clip is just an alpha mask whose content is the clip path filled
   opaque**, so clip and mask are the same code path and *compose* (intersect)
   when both are set. Works identically for a single leaf or a whole group.

3. **Mask content lives in the masked node's space.** A mask node's children are
   rebased into the referencing node's local coordinate system, so one mask def
   is reusable and positioned relative to whatever it masks.

4. **SVG wiring.** `<clipPath>` elements become clip regions (union of their child
   shapes); `<mask>` elements are materialized as mask nodes with their content
   imported as a subtree; `clip-path="url(#id)"` / `mask="url(#id)"` on any
   element attach them.

## Consequences

- Vignettes, gradient/photographic soft masks, knockout reveals, shape-clipped
  fills, and framed groups all work, resolution-independently and re-editably —
  proven end to end (readback): geometric clip, luminance mask, an
  alpha-vs-luminance discriminator, and a gradient soft mask, plus SVG
  `clip-path`/`mask` rendering. Showcased in the `ClipAndMask` story.
- Reuses the existing offscreen-layer/target-pool machinery; the only new GPU
  work is a full-screen multiply pass per clip/mask, and clip/mask forces a node
  to isolate (as opacity/blend already do).
- Coverage is read in linear light (luminance uses linear Rec.709 weights),
  consistent with the pipeline — a deliberate, minor difference from SVG's legacy
  behaviour.
- Deliberate v1 limits: masks/clips compose by intersection but a clip's own
  `objectBoundingBox` units and a referencing element's transform are not remapped
  (clip geometry is taken in the node's local space — exact for untransformed
  references, the common case); no `clipPathUnits`/`maskUnits`/`maskContentUnits`
  beyond that, and no SVG filter-based masks. Each is a clean follow-up.
