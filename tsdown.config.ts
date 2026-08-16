import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['src/index.ts', 'src/evolution-mode.ts', 'src/verification-observer.ts'],
  format: ['esm'],
  hash: false,
  outDir: 'lib',
  outExtensions: () => ({
    dts: '.d.ts',
    js: '.js',
  }),
  sourcemap: true,
  target: 'node22',
})
