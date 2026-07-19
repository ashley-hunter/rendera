# ADR 0001 — Build strategy: foundational engine first

- **Status:** Accepted
- **Date:** 2026-07-19

## Context

Rendera aims to be the basis for increasingly high-quality rendering software:
a canvas engine for drawing and vector apps, with layers, blending, effects,
compositing, and eventually animation, rigging, and skeletal (bones) tools. The
bar for output quality is "Photoshop crispness", and performance must stay
fluid on both desktop and mobile.

The scope effectively spans three products' worth of engine — a raster painting
editor, a vector design editor, and an animation/rigging system. Building all of
it at once risks getting the shared fundamentals wrong. The stated goal is
explicitly *not* speed of delivery but doing things the best way for the long
term.

## Decision

Build the **foundational engine first**, before breadth of features:

- document / scene model,
- GPU compositor and colour pipeline,
- layers and groups,
- transforms (move / rotate / scale),
- selection,
- undo / redo,
- a pan / zoom / rotate viewport,

with only a **minimal raster brush + image layer** as the first thing showcased
in Storybook to prove the core end-to-end. Vector tooling and animation/rigging
are layered on top of this proven core afterwards.

The engine core lives in the framework-agnostic `@rendera/core` library; the
`@rendera/angular` wrapper (and future framework wrappers) only bind it to a UI.
Domain-specific capabilities may later live in additional libraries under the
`@rendera/*` scope.

## Consequences

- Early work produces little user-visible feature breadth; the payoff is a
  correct, reusable core that vector and animation compose onto without rework.
- The core must stay rendering-backend-agnostic enough to test in isolation, yet
  concrete enough to hit quality/performance targets — a tension we accept and
  manage via a pluggable rendering backend.
- Sequencing decisions (which features, in what order) are tracked as their own
  ADRs; this ADR only fixes the overall strategy.
- "Fundamentals correct" becomes the tie-breaker for later trade-offs: when in
  doubt, prefer the more correct foundation over the faster feature.
