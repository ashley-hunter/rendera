# Rendera

Rendera is a generic, framework-agnostic **GPU canvas rendering engine** — a
library, not an application. It provides the building blocks for high-quality
interactive graphics of any kind: a document/scene model, GPU compositing,
layers and groups, transforms, selection, undo/redo, raster and vector
rendering, effects, and (in time) animation and rigging.

Consumers build whatever they need on top. **This repository ships the library
only — no end-user application.**

## Principles

- **Quality first** — reference-grade, crisp output; correct colour and
  precision are the foundation, not a polish step.
- **Fundamentals first** — do things the best way for the long term. Breadth of
  features composes onto a proven core.
- **Model is authoritative; rendering is a projection of it.**
- **Strict layering:** `angular → renderer → core`. The core imports no DOM, GPU,
  or framework APIs and is unit-testable headlessly.

See [`CONTEXT.md`](CONTEXT.md) for the domain model and glossary, the decision
records in [`docs/adr/`](docs/adr/), and the phased plan in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Packages

Libraries live under `packages/` in the `@rendera/*` scope:

| Package | Role |
| --- | --- |
| `@rendera/core` | Framework-agnostic engine kernel (document model, math, history, input, renderer interface). No DOM/GPU. |
| `@rendera/angular` | Thin Angular wrapper that mounts the engine and adapts input/state. |
| `@rendera/webgpu` *(planned)* | WebGPU rendering backend implementing the core's renderer interface. |

Feature libraries (`raster`, `vector`, `effects`, `animation`, `io`) are added
as those areas are built.

## Workspace

This is an [Nx](https://nx.dev) monorepo using **pnpm**.

```bash
pnpm install

# Lint, test and build every library
pnpm nx run-many -t lint test build

# Work on a single project
pnpm nx test core
pnpm nx storybook angular
```

Storybook showcases the library's capabilities and is published to GitHub Pages
on every push to `main`.
