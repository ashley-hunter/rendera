import type { Meta, StoryObj } from '@storybook/angular';
import { Rendera } from './rendera';
import { expect } from 'storybook/test';

const meta: Meta<Rendera> = {
  component: Rendera,
  title: 'Rendera',
};
export default meta;

type Story = StoryObj<Rendera>;

export const Primary: Story = {
  args: {},
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/Untitled/i)).toBeTruthy();
  },
};
