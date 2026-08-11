import gtsConfig from 'gts';

export default [
  {ignores: ['.remember/']},
  ...gtsConfig,
  {
    // gts hardcodes sourceType: 'commonjs' for files matching '**/eslint.config.js' (it expects
    // require()/module.exports); this project's config is now native ESM, so override it back.
    files: ['eslint.config.js'],
    languageOptions: {sourceType: 'module'},
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
      ],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {from: 'package', name: 'test', package: 'node:test'},
            {from: 'package', name: 'describe', package: 'node:test'},
            {from: 'package', name: 'it', package: 'node:test'},
            {from: 'package', name: 'before', package: 'node:test'},
            {from: 'package', name: 'after', package: 'node:test'},
            {from: 'package', name: 'beforeEach', package: 'node:test'},
            {from: 'package', name: 'afterEach', package: 'node:test'},
          ],
        },
      ],
    },
  },
];
