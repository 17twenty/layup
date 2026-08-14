import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { createHelperClient, newHelperSecret, signHelperRequest } from './helper-client';
import { createLogger } from './logging';

const repoRoot = join(process.cwd(), '..', '..');
const helperDir = join(repoRoot, 'native', 'input-helper');

let helper: ChildProcess | undefined;
let socketPath = '';
const secret = newHelperSecret();
const log = createLogger({ level: 'error', write: () => {} });

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'layup-helper-'));
  const binary = join(dir, 'layup-input-helper');
  socketPath = join(dir, 'helper.sock');
  execFileSync('go', ['build', '-o', binary, './cmd/layup-input-helper'], {
    cwd: helperDir,
    stdio: 'inherit',
  });
  helper = spawn(binary, [], {
    env: { ...process.env, LAYUP_HELPER_SECRET: secret, LAYUP_HELPER_SOCKET: socketPath },
    stdio: 'ignore',
  });
}, 120_000);

afterAll(() => helper?.kill('SIGTERM'));

async function connected() {
  const client = createHelperClient({ socketPath, secret, log });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await client.connect();
      return client;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('helper did not start listening');
}

describe('native helper protocol', () => {
  it('accepts an authenticated command and reports capabilities', async () => {
    const client = await connected();

    expect(await client.send('helper.hello')).toMatchObject({ ok: true });

    const capabilities = await client.capabilities();
    // The helper answers honestly about what this build can do rather than
    // claiming an ability it does not have.
    expect(capabilities?.platform).toBe(process.platform);
    expect(typeof capabilities?.detail).toBe('string');

    client.close();
  }, 30_000);

  it('rejects a request signed with the wrong secret', async () => {
    const impostor = createHelperClient({ socketPath, secret: newHelperSecret(), log });
    await impostor.connect();

    const response = await impostor.send('helper.hello');
    // Reaching the socket is not enough: you must hold the session secret.
    expect(response).toMatchObject({ ok: false, code: 'unauthenticated' });

    impostor.close();
  }, 30_000);

  it('rejects a command that is not on the allow-list', async () => {
    const client = await connected();
    const response = await client.send('shell.exec' as never);
    expect(response).toMatchObject({ ok: false, code: 'unknown_command' });
    client.close();
  }, 30_000);

  it('rejects a signature replayed onto a different command', async () => {
    const client = await connected();
    // Hand-rolled request: a valid tag for pointer.move, used for key.
    const auth = signHelperRequest(secret, '1', 'pointer.move');
    const raw = JSON.stringify({ v: 1, id: 'replay-1', command: 'key', auth });

    const { connect } = await import('node:net');
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      const socket = connect(socketPath, () => socket.write(`${raw}\n`));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        resolve(JSON.parse(chunk.trim().split('\n')[0]!));
        socket.destroy();
      });
    });

    expect(response).toMatchObject({ ok: false, code: 'unauthenticated' });
    client.close();
  }, 30_000);

  it('answers malformed input without crashing', async () => {
    const { connect } = await import('node:net');
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      const socket = connect(socketPath, () => socket.write('not json\n'));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        resolve(JSON.parse(chunk.trim().split('\n')[0]!));
        socket.destroy();
      });
    });
    expect(response).toMatchObject({ ok: false, code: 'malformed' });

    // Still alive afterwards.
    const client = await connected();
    expect(await client.send('helper.hello')).toMatchObject({ ok: true });
    client.close();
  }, 30_000);

  it('is unreachable from the renderer', () => {
    // The guarantee that matters: no preload/IPC path exposes the helper.
    const preload = readFileSync('src/preload/api.ts', 'utf8');
    const ipc = readFileSync('src/shared/ipc.ts', 'utf8');
    for (const source of [preload, ipc]) {
      expect(source).not.toMatch(/helper|LAYUP_HELPER_SECRET|input-helper/i);
    }
  });
});
