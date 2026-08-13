/**
 * Realtime smoke test across the real boundary: the desktop's realtime client
 * against a real Go control service over a real WebSocket.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRealtimeClient, type RealtimeClient } from './realtime-client';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const controlDir = join(repoRoot, 'services', 'control');
const port = 8900 + (process.pid % 90);
const baseUrl = `http://127.0.0.1:${port}`;

let binary: string;
let server: ChildProcess | undefined;
const clients: RealtimeClient[] = [];

function startServer() {
  server = spawn(binary, [], {
    env: { ...process.env, LAYUP_LISTEN_ADDR: `127.0.0.1:${port}`, LAYUP_ENV: 'smoke' },
    stdio: 'ignore',
  });
}

async function waitUntil(predicate: () => boolean, label: string, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function track(client: RealtimeClient): RealtimeClient {
  clients.push(client);
  return client;
}

describe('desktop realtime client against the control service', () => {
  beforeAll(() => {
    binary = join(mkdtempSync(join(tmpdir(), 'layup-rt-')), 'layup-control');
    execFileSync('go', ['build', '-o', binary, './cmd/control'], { cwd: controlDir, stdio: 'inherit' });
    startServer();
  }, 120_000);

  afterAll(() => {
    for (const client of clients) client.stop();
    server?.kill('SIGTERM');
  });

  it('connects, is told who it is, and answers heartbeats', async () => {
    const client = track(createRealtimeClient({ baseUrl, devUser: 'karl', reconnectBaseMs: 100 }));
    client.start();

    await waitUntil(() => client.state().status === 'connected', 'realtime connection');
    expect(client.state().userId).toMatch(/^usr_/);
    expect(client.state().organisationId).toBe('org_devlayup');

    // The server's heartbeat keeps arriving; the watchdog only fires if it stops.
    const beats: number[] = [];
    client.on('heartbeat', (message) => beats.push((message.payload as { seq: number }).seq));
    await waitUntil(() => beats.length >= 1, 'a heartbeat');
    expect(beats[0]).toBeGreaterThan(0);
    expect(client.state().status).toBe('connected');
  }, 60_000);

  it('two clients connect independently and the server tracks both', async () => {
    const nick = track(createRealtimeClient({ baseUrl, devUser: 'nick', reconnectBaseMs: 100 }));
    const emelia = track(createRealtimeClient({ baseUrl, devUser: 'emelia', reconnectBaseMs: 100 }));
    nick.start();
    emelia.start();

    await waitUntil(() => nick.state().status === 'connected', 'nick connected');
    await waitUntil(() => emelia.state().status === 'connected', 'emelia connected');
    expect(nick.state().connectionId).not.toBe(emelia.state().connectionId);
    expect(nick.state().userId).not.toBe(emelia.state().userId);
  }, 60_000);

  it('reconnects by itself after the server restarts, without duplicating handlers', async () => {
    const client = track(createRealtimeClient({ baseUrl, devUser: 'priya', reconnectBaseMs: 100 }));
    let helloCount = 0;
    client.on('hello.ok', () => {
      helloCount += 1;
    });
    client.start();
    await waitUntil(() => client.state().status === 'connected', 'first connection');
    expect(helloCount).toBe(1);

    server?.kill('SIGKILL');
    server = undefined;
    await waitUntil(() => client.state().status === 'reconnecting', 'reconnect after outage');

    startServer();
    await waitUntil(() => client.state().status === 'connected', 'reconnection', 200);

    // One handler, one hello per connection: reconnecting must not double-subscribe.
    expect(helloCount).toBe(2);
  }, 90_000);
});
