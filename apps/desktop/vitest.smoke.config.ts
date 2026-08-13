import { defineConfig } from 'vitest/config';

/**
 * Cross-component smoke tests: real Go control service, real HTTP.
 * Kept separate from the unit run because they need a Go toolchain.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.smoke.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
