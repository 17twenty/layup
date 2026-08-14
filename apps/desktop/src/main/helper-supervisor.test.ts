import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createHelperSupervisor } from './helper-supervisor';
import { createLogger } from './logging';
import type { HelperClient } from './helper-client';

class FakeChild extends EventEmitter {
  killed = false;
  constructor(readonly env: NodeJS.ProcessEnv) {
    super();
  }
  kill() {
    this.killed = true;
    this.emit('exit', 0);
    return true;
  }
}

function fakeClient(overrides: Partial<HelperClient> = {}): HelperClient {
  return {
    connect: async () => {},
    send: async () => ({ ok: true }),
    capabilities: async () => ({
      platform: 'darwin',
      pointerMove: false,
      pointerButton: false,
      pointerWheel: false,
      keyboard: false,
      detail: 'macOS input injection is not implemented yet (P1-0503, P1-0504)',
    }),
    close: () => {},
    connected: () => true,
    ...overrides,
  };
}

function harness(options: { client?: HelperClient; maxRestarts?: number } = {}) {
  // Per-harness, not static: two harnesses must not share their children.
  const spawned: FakeChild[] = [];
  const states: Array<{ running: boolean; restarts: number }> = [];
  const supervisor = createHelperSupervisor({
    binaryPath: '/usr/local/bin/layup-input-helper',
    log: createLogger({ level: 'error', write: () => {} }),
    spawnImpl: (_path, env) => {
      const child = new FakeChild(env);
      spawned.push(child);
      return child as never;
    },
    createClient: () => options.client ?? fakeClient(),
    restartBackoffMs: 0,
    ...(options.maxRestarts === undefined ? {} : { maxRestarts: options.maxRestarts }),
    onState: (state) => states.push({ running: state.running, restarts: state.restarts }),
  });
  return { supervisor, states, children: () => spawned };
}

describe('native helper lifecycle', () => {
  it('starts once and reports capability state without exposing privilege', async () => {
    const h = harness();
    const state = await h.supervisor.start();

    expect(h.children()).toHaveLength(1);
    expect(state.running).toBe(true);
    // The desktop learns *what is possible*, not how to do it.
    expect(state.capabilities?.keyboard).toBe(false);
    expect(state.detail).toMatch(/not implemented yet/);
  });

  it('gives the helper a fresh secret and socket, never a fixed one', async () => {
    const first = harness();
    await first.supervisor.start();
    const second = harness();
    await second.supervisor.start();

    const a = first.children()[0]!.env;
    const b = second.children()[0]!.env;
    expect(a.LAYUP_HELPER_SECRET).toHaveLength(64);
    expect(a.LAYUP_HELPER_SECRET).not.toBe(b.LAYUP_HELPER_SECRET);
    expect(a.LAYUP_HELPER_SOCKET).not.toBe(b.LAYUP_HELPER_SOCKET);
  });

  it('detects a crash and restarts with new credentials', async () => {
    const h = harness();
    await h.supervisor.start();
    const firstSecret = h.children()[0]!.env.LAYUP_HELPER_SECRET;

    h.children()[0]!.emit('exit', 1);
    await vi.waitFor(() => expect(h.children()).toHaveLength(2));

    expect(h.supervisor.state().restarts).toBe(1);
    // The dead process's secret is worthless to anyone who captured it.
    expect(h.children()[1]!.env.LAYUP_HELPER_SECRET).not.toBe(firstSecret);
  });

  it('gives up on a crash loop rather than restarting forever', async () => {
    const h = harness({ maxRestarts: 2 });
    await h.supervisor.start();

    for (let i = 0; i < 5; i += 1) {
      h.children()[h.children().length - 1]!.emit('exit', 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(h.children().length).toBeLessThanOrEqual(3);
    expect(h.supervisor.state().detail).toMatch(/keeps crashing/);
    expect(h.supervisor.state().running).toBe(false);
  });

  it('exits with the desktop', async () => {
    const h = harness();
    await h.supervisor.start();
    h.supervisor.stop();

    expect(h.children()[0]!.killed).toBe(true);
    expect(h.supervisor.state().running).toBe(false);

    // A deliberate stop is not a crash: nothing restarts.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.children()).toHaveLength(1);
  });

  it('stays usable when the helper cannot be reached', async () => {
    const h = harness({
      client: fakeClient({
        connect: async () => {
          throw new Error('ECONNREFUSED');
        },
        connected: () => false,
        capabilities: async () => undefined,
      }),
    });
    const state = await h.supervisor.start();

    // Remote control is simply unavailable; the desktop carries on.
    expect(state.running).toBe(false);
    expect(state.capabilities).toBeUndefined();
  }, 20_000);
});
