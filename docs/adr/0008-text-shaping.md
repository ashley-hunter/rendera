# ADR 0008 — Text shaping & rendering

## Status

Accepted.

## Context

Rendera needs typographically correct text: real shaping (ligatures, kerning,
GPOS/GSUB, complex scripts, bidirectional runs), not naïve glyph-per-character
placement. It must stay resolution-independent (the Photoshop/Illustrator bar)
and framework-agnostic — shaping is pure computation and belongs in the DOM-free
`@rendera/core`, testable headlessly. We already have an analytic vector fill
(ADR 0007) that renders arbitrary paths crisply at any zoom, with paint
(solid/gradient) and strokes.

## Decision

**Shape with HarfBuzz (WASM); render glyph outlines through the existing analytic
vector fill.**

1. **Shaper — HarfBuzz via `harfbuzzjs`.** HarfBuzz is the shaper Chrome, Firefox,
   and Android use; nothing else matches its fidelity. `harfbuzzjs` (1.x) is an
   ESM build that instantiates the wasm on import (top-level await) and exposes
   both shaping *and* glyph **outline** extraction (the HarfBuzz 4+ draw API,
   `font.glyphToJson` → M/L/Q/C/Z in font design units). We take outlines, not
   bitmaps, so glyphs are just vector geometry. The wasm is **lazily** imported
   (dynamic `import()`), so pulling in `@rendera/core` costs nothing until text
   is actually used.

2. **Outlines, not an atlas (for now).** Each glyph's outline flows straight
   through the ADR 0007 analytic fill: resolution-independent at any zoom, and it
   inherits solid/gradient paint and strokes for free (gradient text, outlined
   text — no new code). An **MSDF atlas** for bulk small UI text is a deliberate
   follow-up (a performance optimization, not a fidelity one).

3. **Full itemization in core.** HarfBuzz shapes one uniform run (single
   direction + script). Real text is segmented first: the Unicode Bidirectional
   Algorithm (UAX #9, via `bidi-js`) resolves an embedding level per character,
   and a small UAX #24 itemizer (over `unicode-properties` script data, resolving
   `Common`/`Inherited`) splits into uniform runs. Runs are shaped, then reordered
   into visual order by bidi level (rule L2). Layout advances a pen (with letter
   spacing), stacks lines (hard `\n` breaks; wrapping is a follow-up), applies
   alignment, and bakes every glyph outline into ONE local-space `Path`.

4. **A `text` node, lowered to vector geometry.** `TextNode` holds data only
   (string, `fontId`, size, paint, alignment, direction, features…). Because
   shaping is async (wasm) and expensive, layout is computed out-of-band and the
   resulting local-space glyph path is handed to `buildRenderList` via a
   `textPaths` map; a text node then emits the exact same `draw-path` commands as
   a `path` node. Fonts are registered by id; the model never holds font bytes.

5. **Colour / geometry.** Outlines come back Y-up in font units; layout scales by
   `fontSize / upem` and flips to local Y-down. Paint (including gradient
   geometry) is evaluated in the node's local space, exactly as for paths.

## Consequences

- Highest-fidelity shaping available on the web, with outlines that stay crisp at
  any zoom and paint with gradients/strokes like any vector — a capability an
  atlas-only approach can't match for display type.
- A wasm dependency (~400 KB) enters the stack, but only for consumers who use
  text (lazy dynamic import). Bundlers need small nudges to serve the wasm: Vite
  wants `optimizeDeps.exclude: ['harfbuzzjs']` (+ `server.fs.allow`); Webpack
  (Angular Storybook) wants `resolve.fallback` stubs for the glue's dead Node
  branch (`module`/`fs`/`path`/`url`) and `experiments.topLevelAwait` +
  `asyncWebAssembly`. Both verified.
- Per-glyph analytic fills are O(glyphs) draw-paths; fine for headings/labels,
  and the motivation for the MSDF atlas follow-up on dense body text.
- Deferred: line wrapping, vertical text, MSDF atlas, colour glyphs (the tiny
  HarfBuzz build is monochrome-outline only), and richer per-run font fallback.
- Licensing: HarfBuzz (Old MIT), `bidi-js`/`unicode-properties` (MIT), and the
  bundled Crimson Pro (OFL-1.1) are all safe to redistribute; recorded in
  `THIRD-PARTY-NOTICES.md`.
