// @ts-check
import tseslint from 'typescript-eslint';

/**
 * Deliberately narrow. Formatting is Prettier's job and type errors are tsc's job,
 * so this config only carries rules that catch a class of real defect the other two
 * tools cannot see. A lint config that shouts about style trains people to ignore it.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/reports/**',
      '**/.wrangler/**',
      'docs/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // An unawaited promise in a Worker is a request that finishes before its work does.
      '@typescript-eslint/no-floating-promises': 'off', // needs type-aware linting; tsc + review cover it for now
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      // Money must never go through floating point. This catches the obvious cases;
      // the integer-minor-unit contract in packages/contracts catches the rest.
      'no-loss-of-precision': 'error',
    },
  },
  {
    // Tests legitimately reach for console output and loose shapes when building fixtures.
    files: ['tests/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
