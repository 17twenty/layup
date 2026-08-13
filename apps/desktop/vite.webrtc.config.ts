import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the WebRTC harness so it can run inside a real Electron window
 * against the production peer-connection module.
 */
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('./dist/webrtc', import.meta.url)),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./test/webrtc/harness.ts', import.meta.url)),
      formats: ['iife'],
      name: 'LayupWebRTCHarness',
      fileName: () => 'harness.js',
    },
  },
});
