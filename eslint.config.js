// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .claude/ holds the tooling's own state, and its worktrees/ is a checkout of
  // this same repository per branch in progress — build output and all. Linting
  // those is linting copies of the project through a config that does not apply
  // to them: on this machine it turned a clean run into 574 errors, every one of
  // them from a file git itself excludes.
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.claude/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // Two imports from one module drift apart: one gets a name added, the
      // other keeps the stale list. A type-only import beside a value import
      // is allowed, because consistent-type-imports above asks for exactly that.
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // Plain Node scripts, outside the TypeScript program that supplies these globals.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
);
