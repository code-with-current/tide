import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
      // The real view SDK (vite.config.ts alias target) reads `window` at module
      // scope — unimportable in the node test env. Stub it.
      'electrobun/view': path.resolve(__dirname, './test/electrobun-view-mock.ts'),
      // The main SDK talks to native ffi at module scope — same treatment.
      'electrobun/main': path.resolve(__dirname, './test/electrobun-main-mock.ts'),
    },
  },
});
