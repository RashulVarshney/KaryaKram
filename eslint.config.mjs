import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // packages/core must stay pure: no IO, no clock, no randomness.
    // Anything needing the outside world gets passed in as an argument.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'packages/core must stay pure — no database access.' },
            { name: 'fs', message: 'packages/core must stay pure — no filesystem access.' },
            { name: 'node:fs', message: 'packages/core must stay pure — no filesystem access.' },
            {
              name: 'node:fs/promises',
              message: 'packages/core must stay pure — no filesystem access.',
            },
            { name: 'http', message: 'packages/core must stay pure — no network access.' },
            { name: 'node:http', message: 'packages/core must stay pure — no network access.' },
            { name: 'https', message: 'packages/core must stay pure — no network access.' },
            { name: 'node:https', message: 'packages/core must stay pure — no network access.' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'packages/core must stay pure — pass the current time in as an argument instead of calling Date.now().',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'packages/core must stay pure — pass the current time in as an argument instead of `new Date()`.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'packages/core must stay pure — pass randomness in as an argument instead of calling Math.random().',
        },
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'packages/core must stay pure — no network access.',
        },
      ],
    },
  },
);
