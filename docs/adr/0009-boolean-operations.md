# ADR 0009 — Boolean path operations

## Status

Accepted.

## Context

Vector editing needs boolean combinations of shapes (Illustrator Pathfinder:
union, intersect, difference, exclude). The question is *what the result is*:
a rendered region, or a real editable path. We already have a resolution-
independent analytic fill + a compositor, so a coverage-based boolean
(min/max/subtract on coverage) would be trivial and robust — but it yields a
rendered region, not geometry you can stroke, hit-test, or edit further.

## Decision

Compute **geometric Bézier booleans that produce a new exact-curve `Path`**, and
express them as a **non-destructive `boolean` node**.

- **Algorithm — split · classify · select · reassemble.** Both operands become
  closed contours of cubic Béziers (lines/quads are exact cubics). Every A-curve
  is intersected with every B-curve by **recursive subdivision** (bounding-box
  reject → chord intersection once both curves are flat), and both operands are
  split at those parameters into pieces that each lie entirely inside or outside
  the other. Each piece is **classified** by testing its midpoint against the
  other operand (winding), the operation **selects and orients** the pieces it
  keeps (union = outside∪outside; intersect = inside∪inside; difference =
  A-outside + B-inside reversed; xor = (A−B) ∪ (B−A)), and the selected directed
  pieces are **reassembled** end-to-end into closed contours. Curves stay exact —
  the result is never flattened.

- **Non-destructive node.** A `boolean` container node holds an `op` and child
  operands (paths, or nested booleans); `buildRenderList` resolves it at render
  into one combined path, painted like any path (solid/gradient fill + stroke).
  Operands stay individually editable; `difference`/`xor` fold left-to-right.
  This matches the parametric, evaluated-at-render direction (effects,
  adjustment layers) and lets booleans nest.

## Consequences

- The combined outline is a real editable path — strokable, hit-testable, and
  composable with everything else (gradients, blend modes, further booleans).
  Resolution-independent, sharp at any zoom.
- The geometric approach is intrinsically harder than coverage: it targets
  **general-position** inputs (transversal intersections, no coincident edges).
  Heavily-degenerate cases — coincident/overlapping edges, exact tangencies,
  self-intersecting operands — are a known limitation; endpoint matching uses a
  small merge tolerance.
- Resolution runs in `buildRenderList` (pure). For complex operands this is
  non-trivial per frame; a content-keyed cache is a deferred optimization.
- Deferred: robust degenerate handling, boolean of open paths / strokes,
  and baking a boolean back into a plain path (destructive apply).

## Follow-up: self-overlap removal (correct stroking)

`resolveOverlaps(path)` reuses the same split–classify–reassemble machinery on a
*single* path to strip self-overlaps: it splits every cubic at its intersections
with every other cubic (self-intersections, not A-vs-B), then keeps only the
pieces with the nonzero-filled region on exactly one side — dropping interior
seams (inside on both sides) and stray exterior edges — and reorients each kept
edge so the inside is consistently on one side, so the reassembled contours fill
identically.

The motivation is **stroking**. Fonts (and hand-drawn art) routinely self-
overlap: a glyph's crossbar runs back through its body, accent marks sit over
stems, composite glyphs stack components. Nonzero *fill* hides the overlap, but
*stroking the raw contour* inks those interior seams as dark lines inside the
letter — visible on stroked display text, worst at high zoom. `prepareGeom` now
strokes `resolveOverlaps(localPath)` instead of the raw path (the fill still uses
the raw path — nonzero fill is overlap-invariant, and resolving costs nothing
there). Verified two ways: a core test confirms the resolved fill matches the
raw fill exactly while the 'e' crossbar seam's deep-interior stroke coverage
drops from ~128 sample hits to 0, and an end-to-end GPU readback of a stroked
'e' finds zero stroke pixels among 700+ deep-interior fill pixels (42 before the
fix). Resolution is content-keyed cached in `prepareGeom`, ~sub-20ms per glyph.

The split/merge tolerances here are absolute (path units), tuned for ~1000-unit
font coordinates. `resolveOverlaps` therefore **normalizes to a ~1000-unit
working scale** and maps the result back: em-scaled text (~40 units) would
otherwise shatter a glyph into dozens of fragments — stroking those fragments
drew a chaotic mess across the letters — and a very large path would miss
intersections. A scale-invariance test asserts identical topology and fill for a
glyph at 0.04×, 1×, and 25×.
