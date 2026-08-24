import tsParser from '@typescript-eslint/parser'

// Parse-level lint only (no rules enabled), matching the previous
// `eslint --no-config-lookup --ext .ts --parser @typescript-eslint/parser` behavior,
// extended to also cover the .mjs test runners and fixtures.
export default [
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
  },
  {
    files: ['tests/**/*.mjs'],
  },
]
