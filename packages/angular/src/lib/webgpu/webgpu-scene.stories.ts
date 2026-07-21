import type { Meta, StoryObj } from '@storybook/angular';
import { createAdjustmentsScene } from './adjustments-scene';
import { createBlendScene } from './blend-scene';
import { createBooleanScene } from './boolean-scene';
import { createClipMaskScene } from './clip-mask-scene';
import { createEffectsScene } from './effects-scene';
import { createGradientScene } from './gradient-scene';
import { createImageSceneSource } from './image-scene';
import { createPatternScene } from './pattern-scene';
import { createSvgScene } from './svg-scene';
import { createTextScene } from './text-scene';
import { createVectorScene } from './vector-scene';
import { WebGpuScene } from './webgpu-scene';

const meta: Meta<WebGpuScene> = {
  component: WebGpuScene,
  title: 'WebGPU Scene',
};
export default meta;

type Story = StoryObj<WebGpuScene>;

export const Default: Story = { args: {} };

/**
 * A raster image layer textured by a high-frequency test pattern. Zoom in
 * (wheel / pinch) to see bicubic-smooth magnification and crisp text; zoom out
 * to see mip + anisotropic minification stay clean instead of shimmering.
 */
export const CrispImage: Story = {
  args: { scene: createImageSceneSource() },
};

/**
 * Interactive editing. **Click** a shape to select it, or **drag from empty
 * space** to rubber-band select (shift adds); hit-testing respects transforms,
 * winding-rule fills, and stroke width. The selection shows an **oriented frame
 * with handles**: drag the body to **move**, a corner/edge to **scale** (shift =
 * keep aspect, alt = from centre), or the top grip to **rotate**. The frame stays
 * oriented with a rotated shape, so scaling never skews it. While you **move** a
 * shape it **snaps** its edges and centre to nearby shapes, drawing pink
 * alignment guides (hold Cmd/Ctrl to move freely). Select **two or more** shapes
 * and the toolbar grows **align** buttons; **three or more** adds **distribute**.
 * **Keyboard**: arrow keys nudge the selection (Shift = a coarser step),
 * **Delete/Backspace** removes it, **Cmd/Ctrl+D** duplicates it, and holding
 * **Space** turns an empty-space drag into a pan. **Undo / Redo** (buttons or
 * Cmd/Ctrl+Z, +Shift to redo) step through every edit — a whole drag, or a
 * nudge/delete/duplicate/align, is a single undo. The **SVG** / **PNG** toolbar
 * buttons export the scene as a re-importable vector file and a raster capture.
 * The **layers panel** on the right mirrors the document tree (front-to-back):
 * click a row to select it, toggle the dot to hide/show a node, and drag rows to
 * reorder or drop them into a group. Wheel / pinch zooms.
 */
export const Editor: Story = {
  args: { scene: createVectorScene(), selectable: true, exportable: true, showLayers: true },
};

/**
 * Image & pattern fills (the fourth paint kind): one asymmetric tile used four
 * ways — a single placed image (`pad`), a tiled `repeat` pattern, a mirror-tiled
 * `reflect` pattern, and the pattern clipping to a stroked star and an ellipse.
 * Each rides the analytic vector fill, so it stays crisp at any zoom; zoom out
 * and the minified tiles mip-filter cleanly instead of shimmering.
 */
export const PatternFills: Story = {
  args: { scene: createPatternScene() },
};

/**
 * The compositor: four vivid backdrop bands with a 4x4 grid of the W3C blend
 * modes over them (row-major, matching `BLEND_MODES` — multiply, screen,
 * overlay, …), all composited in linear light, plus a half-opacity group.
 */
export const BlendModes: Story = {
  args: { scene: createBlendScene() },
};

/**
 * Vector shapes filled by analytic coverage (ADR 0007) — rounded rects, an
 * ellipse, a star, and an even-odd ring. Zoom in hard: every edge stays
 * razor-sharp and re-rasterizes at the new scale, with no faceting or blur.
 */
export const Vectors: Story = {
  args: { scene: createVectorScene() },
};

/**
 * Gradient paints evaluated analytically in the path shader: multi-stop linear
 * ramps, a two-circle radial with a focal highlight (glossy sphere), a conic
 * colour wheel, `repeat` spread (stripes), OKLab vs linear-light interpolation,
 * and a gradient fill + gradient stroke on one star. Gradients are defined in
 * each shape's local space, so they transform exactly with it — and stay
 * band-free at any zoom.
 */
export const Gradients: Story = {
  args: { scene: createGradientScene() },
};

/**
 * High-fidelity text: real HarfBuzz shaping (ligatures like fi/ffl, kerning like
 * AV/To) with glyph outlines. Large/display type (the headline, "Vector Type")
 * renders through the analytic vector fill — resolution-independent, paints with
 * gradients + strokes like any vector. Small/body text (subtitle, ligature/
 * kerning lines, the wrapped paragraph) auto-routes to a pure-TS MSDF atlas
 * (median + screenPxRange AA), cached per glyph. Zoom in: both stay sharp.
 */
export const Text: Story = {
  args: { scene: createTextScene() },
};

/**
 * Geometric boolean operations — union, intersection, difference, and exclusion
 * (XOR) of a circle and a rounded square. Each result is a NEW exact-curve path
 * (Bézier, not flattened): gradient-filled and stroked to show the combined
 * outline is a real, editable, strokable shape. Zoom in — every edge stays sharp.
 */
export const Booleans: Story = {
  args: { scene: createBooleanScene() },
};

/**
 * A whole SVG illustration — imported, not hand-built (ADR 0010). One embedded
 * `<svg>` string is parsed by the owned, dependency-free, DOM-free importer and
 * lowered to analytic vector nodes: linear + radial gradients resolved in each
 * shape's local space, cubic/quadratic/smooth Béziers and an elliptical arc,
 * grouped strokes, a rotated group of sun rays, and an even-odd cut-out. Because
 * it becomes the same vector geometry as everything else, zoom in — the entire
 * scene stays razor-sharp.
 */
export const SvgImport: Story = {
  args: { scene: createSvgScene() },
};

/**
 * Clipping & masks (ADR 0011). Four cells: a gradient CLIPPED to a star
 * (geometric, antialiased); a gradient softened by a radial LUMINANCE mask (a
 * vignette fading to transparent); a gradient revealed through an ALPHA mask
 * (diagonal bars); and a group of overflowing circles CLIPPED to a rounded
 * rectangle. Clip and mask share one offscreen-coverage mechanism — a clip is
 * just an alpha mask of the filled clip path — and everything stays razor-sharp
 * and re-editable at any zoom.
 */
export const ClipAndMask: Story = {
  args: { scene: createClipMaskScene() },
};

/**
 * Non-destructive effects (ADR 0012): a floating card with a soft DROP SHADOW, a
 * star with a coloured OUTER GLOW, a frosted circle under a Gaussian BLUR, and a
 * card that chains a glow then a shadow. Effects are parametric op-lists
 * evaluated at render — never baked — so they re-resolve and stay smooth at any
 * zoom.
 */
export const Effects: Story = {
  args: { scene: createEffectsScene() },
};

/**
 * Adjustment layers (ADR 0013): the same spectrum subject repeated with six
 * different non-destructive colour adjustments — original, brightness, contrast,
 * desaturate, hue shift, and a levels curve. Parametric op-lists evaluated at
 * render in linear light; nothing is baked.
 */
export const Adjustments: Story = {
  args: { scene: createAdjustmentsScene() },
};
