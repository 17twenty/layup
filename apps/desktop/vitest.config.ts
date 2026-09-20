import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { buildStampDefines } from './scripts/build-stamp';

export default defineConfig({
  plugins: [react()],
  // Tests see the same stamp a real build injects, so a broken injection
  // fails here rather than on a tester's screen.
  define: buildStampDefines(),
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.smoke.test.ts'],
  },
});
