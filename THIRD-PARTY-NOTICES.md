# Third-party notices

Rendera is proprietary (see `LICENSE`). It bundles / depends on the following
third-party components, each under its own permissive license. Their copyright
notices are retained here as required.

## Runtime dependencies

- **HarfBuzz** (via `harfbuzzjs`) — text shaping engine, compiled to WebAssembly.
  License: "Old MIT" (HarfBuzz) / MIT (`harfbuzzjs`).
  © 2019–2026 The harfbuzzjs project authors; © The HarfBuzz project authors.

- **bidi-js** — Unicode Bidirectional Algorithm (UAX #9). License: MIT.
  © 2020 Jason Johnston.

- **unicode-properties** — Unicode script/category lookup (UAX #24 data).
  License: MIT. © 2014 Devon Govett.

## Bundled fonts

- **Crimson Pro** (Regular), embedded in the Storybook showcase.
  License: SIL Open Font License, Version 1.1 (see
  `packages/angular/src/lib/webgpu/fonts/CrimsonPro-OFL.txt`).
  © The Crimson Pro Project Authors (https://github.com/Fonthausen/CrimsonPro).

The same font ships as a test fixture under `packages/core` and `packages/webgpu`.
