import type { Meta, StoryObj } from '@storybook/angular';
import { createImageSceneSource } from './image-scene';
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
