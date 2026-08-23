import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@modules': resolve(__dirname, 'src/modules'),
    },
  },
  // Nest's DI reads design-time type metadata emitted by decorators.
  // esbuild (vitest's default) does not emit it; SWC does.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
