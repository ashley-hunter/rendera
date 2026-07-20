import type { Meta, StoryObj } from '@storybook/angular';
import { createBlendScene } from './blend-scene';
import { createBooleanScene } from './boolean-scene';
import { createGradientScene } from './gradient-scene';
import { createImageSceneSource } from './image-scene';
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
