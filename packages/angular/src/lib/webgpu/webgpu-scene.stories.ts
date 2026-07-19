import type { Meta, StoryObj } from '@storybook/angular';
import { WebGpuScene } from './webgpu-scene';

const meta: Meta<WebGpuScene> = {
  component: WebGpuScene,
  title: 'WebGPU Scene',
};
export default meta;

type Story = StoryObj<WebGpuScene>;

export const Default: Story = { args: {} };
