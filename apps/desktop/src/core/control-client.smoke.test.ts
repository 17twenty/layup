/**
 * Smoke test across the real boundary: the desktop's control client against a
 * freshly built Go control service.
 *
 * Runs with `npm run test:smoke` (and in the CI `smoke` job). It is kept out of
 * the default unit run because it needs a Go toolchain.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlClient } from './control-client';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const controlDir = join(repoRoot, 'services', 'control');
const port = 8800 + (process.pid % 100);
const baseUrl = `http://127.0.0.1:${port}`;

let server: ChildProcess | undefined;
let binary: string;

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, attempts = 50): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i += 1) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last as T;
}

describe('desktop -> control smoke path', () => {
  beforeAll(() => {
    binary = join(mkdtempSync(join(tmpdir(), 'layup-smoke-')), 'layup-control');
    execFileSync('go', ['build', '-o', binary, './cmd/control'], { cwd: controlDir, stdio: 'inherit' });
    server = spawn(binary, [], {
      env: { ...process.env, LAYUP_LISTEN_ADDR: `127.0.0.1:${port}`, LAYUP_ENV: 'smoke' },
      stdio: 'ignore',
    });
  }, 120_000);

  afterAll(() => {
    server?.kill('SIGTERM');
  });

  it('reports connected while the control service is running', async () => {
    const client = createControlClient({ baseUrl, timeoutMs: 1000 });
    const state = await waitFor(() => client.probe(), (s) => s.status === 'connected');

    expect(state.status).toBe('connected');
    expect(state.serverProtocolVersion).toBe(state.clientProtocolVersion);
    expect(state.environment).toBe('smoke');
    expect(state.latencyMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('serves the versioned API only with a supported protocol header', async () => {
    const client = createControlClient({ baseUrl, timeoutMs: 1000 });
    const info = await client.apiGet<{ v: number; type: string; payload: { version: number } }>('/api/protocol');
    expect(info.type).toBe('protocol.info');
    expect(info.payload.version).toBe(1);

    const unversioned = await fetch(`${baseUrl}/api/protocol`);
    expect(unversioned.status).toBe(400);

    const wrongVersion = await fetch(`${baseUrl}/api/protocol`, {
      headers: { 'X-Layup-Protocol-Version': '99' },
    });
    expect(wrongVersion.status).toBe(426);
  }, 30_000);

  it('reports a useful disconnected state once the service stops', async () => {
    server?.kill('SIGTERM');
    server = undefined;

    const client = createControlClient({ baseUrl, timeoutMs: 1000 });
    const state = await waitFor(() => client.probe(), (s) => s.status !== 'connected');

    expect(state.status).toBe('unreachable');
    expect(state.detail).toMatch(/unreachable|did not answer/);
  }, 30_000);
});
