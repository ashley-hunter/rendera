import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              // Layered architecture: angular (wrapper) -> renderer -> core.
              // The core kernel may depend on nothing but itself.
              sourceTag: 'layer:core',
              onlyDependOnLibsWithTags: ['layer:core'],
            },
            {
              sourceTag: 'layer:renderer',
              onlyDependOnLibsWithTags: ['layer:core', 'layer:renderer'],
            },
            {
              sourceTag: 'layer:wrapper',
              onlyDependOnLibsWithTags: [
                'layer:core',
                'layer:renderer',
                'layer:wrapper',
              ],
            },
            {
              sourceTag: 'type:lib',
              onlyDependOnLibsWithTags: ['type:lib'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
