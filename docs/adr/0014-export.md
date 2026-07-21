# ADR 0014 — Export: SVG and PNG out

## Status

Accepted.

## Context

The engine could import SVG (ADR 0010) and render to a canvas, but produced no
*files*. To be a tool rather than a viewer it must emit deliverables: the vector
scene back out as SVG (the natural inverse of import), and the rendered frame as
a raster PNG.

## Decision

Two owned, dependency-free encoders in `@rendera/core` (pure, DOM-free, so both
are unit-tested with no browser), plus a thin renderer convenience for PNG.

- **`exportSvg(doc)` — scene → SVG string.** Walks the document and serializes the
  vector core: `path` nodes (path-data `d`, solid / linear / radial gradient fills
  and strokes, fill rule, stroke cap/join/miter), `group`s, and `layer` rects,
  each with its local `matrix(...)` transform and opacity. Gradients are emitted
  as `<defs>` with `gradientUnits="userSpaceOnUse"` (our gradient geometry is
  already in local space, so it needs no extra mapping) and referenced by
  `url(#id)`. Colours convert linear-light → sRGB (SVG is authored in sRGB), the
  exact inverse of the import path. The content-fitting `viewBox` is the union of
  world-space node bounds. Round-trips: `exportSvg` → `importSvg` preserves path
  geometry, fill, and fill-rule (a test asserts it).
- **Graceful degradation.** Constructs SVG can't represent losslessly degrade
  instead of emitting invalid markup: a conic gradient becomes its first stop as a
  solid (SVG has no conic primitive), an image-paint fill becomes `none` (the
  pixels live out-of-band by `assetId`), and text / boolean nodes are skipped
  (their children still recurse). A full-fidelity round-trip is a non-goal;
  faithful export of the common vector cases is.
- **`encodePng(rgba, w, h)` — pixels → PNG bytes.** A valid 8-bit RGBA (colour
  type 6) PNG: signature, IHDR, one IDAT, IEND, with CRC-32 per chunk and an
  Adler-32 zlib trailer. The DEFLATE payload uses **stored (uncompressed) blocks**
  — larger files than a real compressor, but correct, tiny to implement, and read
  by every decoder. A real DEFLATE is a deferred optimization; the goal is a
  faithful export, not minimal bytes.
- **`WebGpuRenderer.toPng()`** reads back the presented frame, packs it tight as
  top-to-bottom RGBA (unswizzling BGRA targets, dropping row padding), and calls
  `encodePng` — one call from a rendered scene to PNG bytes.

## Consequences

- The scene is now portable both ways (SVG in and out) and the render is
  capturable (PNG), so results leave the engine as files.
- SVG export targets the vector subset; text-as-`<text>`, image fills as
  `<pattern>`/`<image>`, conic gradients, and booleans-as-paths are future
  fidelity work.
- Stored-block PNGs are larger than compressed ones; a DEFLATE compressor (or
  delegating to the platform where available) is a later size optimization.
