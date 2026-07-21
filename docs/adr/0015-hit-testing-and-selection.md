# ADR 0015 — Hit-testing & selection (editing foundation)

## Status

Accepted.

## Context

Everything so far renders and exports a document; nothing lets a user *point at*
it. The first step from a renderer toward an editor is the pointer/geometry
layer: map a screen point to the object under it, and describe the box around a
selection. This must be pure model logic (no GPU, no DOM), so it is deterministic
and unit-tested, and reusable by any front-end.

## Decision

Add owned, pure functions over `SceneDocument` in `@rendera/core`:

- **`hitTest(doc, worldPoint, options)` → topmost node id or null.** Walks the
  tree **front-to-back** (later siblings and deeper descendants are painted on
  top, so they win), and for each node:
  - transforms the point into the node's **local** space via the inverse world
    matrix (so hit-testing respects every transform exactly, like rendering);
  - honours a **clip** — a point outside a node's clip region culls the node and
    its whole subtree (matching what's actually drawn);
  - tests the node's **real painted geometry**: a path's fill under its winding
    rule (so an even-odd hole is correctly *not* hit) plus, within a tolerance,
    its **stroke** (distance to the flattened outline ≤ half-width + fuzz); other
    leaves fall back to their local bounding box; groups are hit only via their
    children.
  - Skips `visible === false` nodes and masks.
  - `options.tolerance` is a world-space pointer fuzz (thin strokes/edges are easy
    to grab); `options.select: 'outermost'` returns the hit's top-level ancestor
    (click-selects the whole group) instead of the leaf.
- **`selectionBounds(doc, ids)`** unions the world-space AABBs of the given nodes
  — the box a front-end draws as a selection frame.
- **Selection state** is just a `ReadonlySet<NodeId>` (`Selection`), with pure
  helpers `toggleSelection` (shift-click) and `selectOnly` (plain click / clear).
  Immutable, so it drops straight into any state model with structural change
  detection.

## Consequences

- A front-end can now translate a click into a selection and frame it, entirely
  from the model — no renderer round-trip, fully testable.
- Hit-testing mirrors the paint model (transforms, clips, winding, stroke width),
  so what you can click matches what you see. Text uses its bounding box (precise
  glyph hit needs the async layout); boolean nodes use bounds rather than the
  resolved outline — both are follow-ups.
- This is the substrate for the next editor slices: transform handles + drag
  gestures (move/scale/rotate a selection) and an undo/redo history.
