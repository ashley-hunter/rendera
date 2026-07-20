# ADR 0010 — SVG import

## Status

Accepted.

## Context

rendera now owns the full vector stack — analytic fills, strokes, gradients,
text, and booleans (ADRs 0007–0009). The obvious way to prove it on real-world
art, and to let users bring existing work in, is to import SVG: the lingua franca
of vector graphics, and what every design tool exports. Import is also a stress
test — it exercises path data, paints, transforms, groups, and text end-to-end on
files we didn't author.

The constraints are the usual rendera ones. `@rendera/core` is **DOM-free** (it
must run headless and in any framework), so we cannot lean on the browser's
`DOMParser`/SVG DOM. And the ethos is **own the fundamentals** — no opaque
third-party SVG library whose behaviour and licensing we don't control.

## Decision

**Own a pure-TypeScript, dependency-free, DOM-free SVG importer in `@rendera/core`
that lowers SVG to the existing analytic vector nodes.** Scope: geometry + paint +
text, styled by presentation attributes and inline `style=`.

1. **Owned parsers, no dependencies.** Four small, independently-tested modules:
   - `xml` — a minimal well-formed-input XML parser (elements, attributes, self-
     closing, comment/CDATA/PI/DOCTYPE skipping, entity + numeric-reference
     decoding, namespace-prefix stripping). No browser DOM.
   - `path-data` — the complete `d` grammar (`M/L/H/V/C/S/Q/T/A/Z`, absolute +
     relative, implicit repetition, the compact number syntax `1.5.5`/`1-2`/flag
     packing), with elliptical **arcs converted to cubic Béziers** so output is a
     plain `Path` that flows through the analytic fill — no arc primitive needed.
   - `transform-attr` — the `transform` list (`matrix`/`translate`/`scale`/
     `rotate`/`skewX`/`skewY`) composed to an affine, plus `matrixToTransform`
     (added to core's transform module) to decompose an arbitrary affine into the
     node's TRS+skew transform, round-tripping through `toMatrix` (reflections
     included).
   - `color` — CSS/SVG colour → **linear-light** RGBA (hex 3/4/6/8, `rgb()/rgba()`
     0–255 or %, `hsl()/hsla()`, the full named-colour table, `transparent`,
     `currentColor`, `none`), through the exact sRGB transfer since the compositor
     works in linear light.

2. **Lower to existing nodes; nothing new to render.** Shapes (`rect` with
   elliptical `rx/ry` corners, `circle`, `ellipse`, `line`, `polyline`, `polygon`,
   `path`) become `path` nodes; `<g>`/`<a>` become groups; `<text>` becomes a text
   node; `<use>` re-imports its target. Geometry stays in each element's own user
   space and the element's own `transform` becomes the **node** transform, so the
   scene graph composes ancestor transforms — nothing is baked into leaf
   coordinates. The `<svg>` root becomes a group carrying the
   `viewBox → viewport` transform (`preserveAspectRatio` meet/none).

3. **Styling: presentation attributes + inline `style=`, inherited.** A style
   context (fill / stroke / stroke-width / fill-rule / colour / font-\*) is merged
   down the tree, with `style=` winning over presentation attributes. This covers
   the overwhelming majority of real and exported SVG; a full CSS cascade
   (`<style>` selectors + specificity) is a deliberate follow-up.

4. **Paints resolve in the shape's local space.** A `fill="url(#id)"` reference
   resolves against a gradient registry (built once, resolving `href` inheritance)
   into a rendera linear/radial `Paint` expressed in the shape's local space:
   `userSpaceOnUse` directly, `objectBoundingBox` mapped through the shape's
   bounding box, with `gradientTransform` baked into the points and
   `spreadMethod → spread`. So an imported gradient transforms with its shape
   exactly like any authored paint.

## Consequences

- Real SVG art renders through the same resolution-independent analytic pipeline
  as everything else — a whole imported illustration stays razor-sharp at any
  zoom, and its paints/strokes are first-class editable nodes, not a flattened
  blit. Proven end-to-end (import → GPU → readback) and showcased in the
  `SvgImport` Storybook story.
- No new runtime dependency, and the importer runs headless in DOM-free core —
  unit-tested without a browser.
- Deliberate v1 limitations, each a clean follow-up: no full CSS cascade
  (`<style>`/selectors); no filters, patterns, clip-paths, or masks (the latter
  two await a clipping/masking capability); colours interpolate in linear light
  rather than SVG's legacy sRGB, and a radial gradient on a non-square
  `objectBoundingBox` approximates SVG's ellipse with the box's mean radius; text
  positioning maps `text-anchor`/baseline approximately (baseline seated by an
  estimated ascender, `tspan` flattened) pending richer SVG text layout.
