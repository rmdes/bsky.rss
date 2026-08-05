module.exports = [
  {ignores: ['.remember/']},
  ...require('gts'),
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {'@typescript-eslint': require('typescript-eslint').plugin},
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
      ],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [{from: 'package', name: 'test', package: 'node:test'}],
        },
      ],
    },
  },
];
