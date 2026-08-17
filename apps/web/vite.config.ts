import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The web guest client: a second, unprivileged consumer of `apps/desktop`'s
 * `core/` - the half of the desktop app that already imports nothing from
 * Node or Electron (ARCHITECTURE.md §3.1, the web-guests design doc §7).
 *
 * `@core` is an alias, not a package. Extracting `core/` into a real
 * workspace package is the correct long-term boundary and is deliberately
 * not done here: it would mean rewriting ~50 imports across a desktop app
 * whose suite just went green, for a cost this alias pays in six lines.
 * Extract when a second stable consumer earns it.
 *
 * This workspace deliberately has no `@types/node` of its own (see
 * tsconfig.json) - but measured, not assumed: npm hoists `apps/desktop`'s
 * `@types/node` to the repo root `node_modules`, which `tsc` can still see
 * from here, so a bare `import ... from 'node:fs'` in `core/` type-checks
 * clean regardless. The guard that actually holds is this build step: Vite
 * externalises a Node built-in for a browser target rather than polyfilling
 * it, and Rollup then fails hard because the named import (e.g.
 * `readFileSync`) does not exist on that empty shim. `npm run build
 * --workspace apps/web` (`make build-web`) is `tsc --noEmit && vite build`,
 * so the failing half still fails the command - it just is not the half
 * anyone would have guessed.
 */
export default defineConfig({
  // Served from https://<server>/j/, so every asset URL has to be written
  // relative to that prefix at build time. With the default '/' the bundle
  // would ask for /assets/... - which is the download page's directory, not
  // this app's - and the join page would load as a blank white rectangle
  // with two 404s in the console.
  base: '/j/',
  plugins: [react()],
  resolve: {
    alias: {
      '@core': new URL('../desktop/src/core', import.meta.url).pathname,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5274,
    strictPort: true,
  },
});
