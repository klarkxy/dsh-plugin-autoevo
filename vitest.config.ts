import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    exclude: [
      'tests/unit/package-artifact.spec.ts',
      'tests/unit/confirmation-gates.spec.ts',
    ],
    passWithNoTests: false,
  },
})
