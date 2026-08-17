import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The same `@core` alias as vite.config.ts, kept separate rather than
 * imported from it - the desktop workspace does the same (vite.config.ts vs
 * vitest.config.ts) rather than making the test runner depend on the build
 * config's own assumptions (a build-only `define`, for one).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': new URL('../desktop/src/core', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
