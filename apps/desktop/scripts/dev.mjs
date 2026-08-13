#!/usr/bin/env node
/**
 * Dev runner: starts the Vite renderer server, compiles main/preload, then
 * launches Electron pointed at the dev server.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';

const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) {
  throw new Error('vite dev server did not report a local URL');
}
server.printUrls();

await new Promise((resolve, reject) => {
  const tsc = spawn('npm', ['run', 'build:main'], { stdio: 'inherit', shell: false });
  tsc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build:main exited ${code}`))));
});

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, LAYUP_RENDERER_URL: url },
});

child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
