/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';
import { playwright } from '@vitest/browser-playwright';

// WebGPU requires a real browser. Headless Chromium exposes a working WebGPU
// implementation via SwiftShader (software) with these flags, so the backend
// is tested against a real device — including pixel readback. Locally, point
// CHROME_BIN at a Chromium binary; in CI, Playwright's own Chromium is used.
const CHROMIUM_WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--use-angle=swiftshader',
  '--enable-features=Vulkan',
];

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/webgpu',
  plugins: [
    nxViteTsPaths(),
    nxCopyAssetsPlugin(['*.md']),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(import.meta.dirname, 'tsconfig.lib.json'),
      pathsToAliases: false,
    }),
  ],
  // Uncomment this if you are using workers.
  // worker: {
  //   plugins: () => [ nxViteTsPaths() ],
  // },
  // Configuration for building your library.
  // See: https://vite.dev/guide/build.html#library-mode
  build: {
    outDir: '../../dist/packages/webgpu',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: 'webgpu',
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es' as const],
    },
    rolldownOptions: {
      // External packages that should not be bundled into your library.
      external: [],
    },
  },
  test: {
    name: 'webgpu',
    watch: false,
    globals: true,
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: 'chromium' }],
      provider: playwright({
        launchOptions: {
          args: CHROMIUM_WEBGPU_ARGS,
          executablePath: process.env['CHROME_BIN'] || undefined,
        },
      }),
    },
    coverage: {
      reportsDirectory: '../../coverage/packages/webgpu',
      provider: 'v8' as const,
    },
  },
}));
