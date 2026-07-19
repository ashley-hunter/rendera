# ADR 0005 — Package architecture

- **Status:** Accepted
- **Date:** 2026-07-19
- **Relates to:** ADR 0002 (renderer seam), ADR 0004 (document model)

## Context

The engine must stay framework-agnostic and renderer-pluggable, with a strict
`angular → renderer → core` dependency direction. Nx makes splitting libraries
cheap, and physical package boundaries are the most reliable way to *enforce*
that the core never imports GPU or DOM APIs. The product owner chose to establish
the kernel/backend split now (rather than a single core split later), and to add
area-specific libraries as they are built.

## Decision

Organise the workspace as focused `@rendera/*` libraries under `packages/`:

**Core layer (build now):**
- **`@rendera/core`** — the framework-agnostic, DOM-free, GPU-free **engine
  kernel**: document record store + node/util registries, history/diff engine,
  selection & transform math, camera & coordinate math, spatial index, input
  abstraction (`PointerInput`) + tool state machines, and the **renderer
  interface** (the seam). Pure TypeScript, unit-testable headlessly.
- **`@rendera/webgpu`** — the **WebGPU rendering backend**, implementing the
  core's renderer interface (device/pipeline setup, tiled compositor, colour
  pipeline, capability detection). Created when the first rendering work starts;
  it depends on `@rendera/core`, never the reverse.
- **`@rendera/angular`** — the thin Angular adapter: mounts a backend on a
  `<canvas>`, translates DOM `PointerEvent`s into `PointerInput`, and reflects
  core state into Angular signals. Contains no engine logic.

**Feature layer (add each when its phase begins):**
- `@rendera/raster` — brush engine and raster tools.
- `@rendera/vector` — path/shape model, vector rasterization, text.
- `@rendera/effects` — adjustment layers, non-destructive effect stacks.
- `@rendera/animation` — timelines, state machines, rigging/bones.
- `@rendera/io` — import/export codecs and the document file format.

## Rules

- **Dependency direction is enforced** with Nx module boundaries / ESLint rules:
  `@rendera/core` may not depend on any renderer, framework, DOM, or GPU package;
  wrappers and backends depend inward only.
- Feature libraries depend on `@rendera/core` (and may depend on a backend
  capability via its interface, not its implementation).
- Scope stays `@rendera/*` everywhere (see the workspace scope decision).

## Consequences

- Slightly more Nx boilerplate per library, in exchange for boundaries that make
  the framework-agnostic / renderer-pluggable guarantees real rather than
  aspirational.
- New areas do **not** get empty packages up front (we rejected "fully modular
  upfront"); a package is created when there is code to put in it, avoiding churn.
- The existing `@rendera/core` placeholder is repurposed as the kernel; the
  existing `@rendera/angular` becomes the wrapper described here.
