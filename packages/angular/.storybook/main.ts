import type { StorybookConfig } from '@storybook/angular';

const config: StorybookConfig = {
  stories: ['../**/*.@(mdx|stories.@(js|jsx|ts|tsx))'],
  addons: [],
  framework: {
    name: '@storybook/angular',
    options: {},
  },
  // HarfBuzz (harfbuzzjs) is an ESM module with a top-level await whose
  // Emscripten glue has a Node-only branch that `require('module')`/`fs`. In the
  // browser bundle that branch is dead, but Webpack still tries to resolve those
  // builtins — stub them false. It locates its `.wasm` via `new URL(..., import.meta.url)`,
  // which Webpack 5 emits as an asset once async WebAssembly + top-level await
  // are enabled.
  webpackFinal: async (webpackConfig) => {
    webpackConfig.resolve = webpackConfig.resolve ?? {};
    webpackConfig.resolve.fallback = {
      ...(webpackConfig.resolve.fallback ?? {}),
      module: false,
      fs: false,
      path: false,
      url: false,
    };
    webpackConfig.experiments = {
      ...(webpackConfig.experiments ?? {}),
      topLevelAwait: true,
      asyncWebAssembly: true,
    };
    return webpackConfig;
  },
};

export default config;

// To customize your webpack configuration you can use the webpackFinal field.
// Check https://storybook.js.org/docs/react/builders/webpack#extending-storybooks-webpack-config
// and https://nx.dev/recipes/storybook/custom-builder-configs
