# ADR 0006 — Transform representation: decomposed TRS, matrix derived

- **Status:** Accepted
- **Date:** 2026-07-19
- **Relates to:** ADR 0004 (document model), future animation ADRs

## Context

Node transforms can be stored either as a raw affine matrix (decomposed to
translate/rotate/scale/skew when a UI needs it) or as decomposed channels (with
the matrix derived). Matrix decomposition is **lossy and ambiguous** — a given
matrix can be read as either rotation or a skew+scale combination — which
corrupts a properties panel and, critically, makes it impossible to keyframe
rotation and scale independently. Animation is a stated future goal.

## Decision

Store every node transform as **decomposed, animatable channels** — translate,
rotate, scale, and skew (with an explicit pivot / transform origin) — and
**derive the affine matrix on demand**.

- The affine matrix (6-tuple `[a b c d e f]`, `DOMMatrix`-compatible) is a
  computed value used for rendering, hit-testing, and bounds — never the stored
  source of truth.
- A node's **world transform** is the product of its ancestor transforms and its
  local transform, composed on demand from the flat store.
- **Gizmo handles** (resize/rotate/skew) are a pure function of the selection's
  world-space bounds and the camera — not stored state.
- Coordinate origin is **y-down**, matching DOM/canvas conventions.

## Consequences

- Every animatable value is addressable as `(nodeId, propertyPath)`, so a future
  timeline is just keyframed writes to transform channels — near-free given the
  flat record store (ADR 0004). This keeps the animation door open without any
  animation code now.
- Compositing/hit-testing consume the derived matrix, so they are unaffected by
  the choice.
- We keep TRS-as-truth rather than storing only the matrix; the small cost is
  deriving the matrix each time it changes (cached per node).
