import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'tests/integration/**/*.spec.ts',
      'tests/unit/package-artifact.spec.ts',
      'tests/unit/confirmation-gates.spec.ts',
    ],
    passWithNoTests: false,
  },
})
