import type { Meta, StoryObj } from '@storybook/angular';
import { createBlendScene } from './blend-scene';
import { createGradientScene } from './gradient-scene';
import { createImageSceneSource } from './image-scene';
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
