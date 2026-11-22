import js from '@eslint/js';
import babelParser from '@babel/eslint-parser';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'reports/**',
      '.spike/**',
      '.local-dev/**',
      '.quality-build/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-return-await': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.ts', 'media/**/*.js'],
    ignores: ['src/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'Keep production imports statically visible to architecture checks.',
        },
        {
          selector: 'CallExpression[callee.name="require"]',
          message: 'Use statically analyzable ESM imports.',
        },
        {
          selector: 'CallExpression[callee.property.name="require"]',
          message: 'Do not bypass statically analyzable ESM imports.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { parserOpts: { plugins: ['typescript'] } },
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      'no-dupe-class-members': 'off',
    },
  },
  {
    files: ['media/**/*.js'],
    languageOptions: { globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } },
  },
];
