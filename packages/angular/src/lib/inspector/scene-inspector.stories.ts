import type { Meta, StoryObj } from '@storybook/angular';
import { expect } from 'storybook/test';
import { SceneInspector } from './scene-inspector';

const meta: Meta<SceneInspector> = {
  component: SceneInspector,
  title: 'Scene Inspector',
};
export default meta;

type Story = StoryObj<SceneInspector>;

export const Default: Story = {
  args: {},
  play: async ({ canvas }) => {
    await expect(canvas.getByText('+ Layer')).toBeTruthy();
  },
};
