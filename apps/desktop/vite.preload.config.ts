import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * The preload runs in a sandboxed context, so it must be a single bundled file
 * with no module loader of its own. `electron` stays external - it is injected.
 */
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('./dist/preload', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/preload/index.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});
