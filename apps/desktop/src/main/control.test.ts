import { describe, expect, it, vi } from 'vitest';
import { createControlSupervisor } from './control';
import { createLogger } from './logging';
import type { ControlClient, ControlConnectionState } from '../core/control-client';

function state(overrides: Partial<ControlConnectionState> = {}): ControlConnectionState {
  return {
    status: 'connected',
    baseUrl: 'http://127.0.0.1:8787',
    clientProtocolVersion: 1,
    checkedAtMs: 0,
    ...overrides,
  };
}

function harness(states: ControlConnectionState[]) {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  let clock = 0;
  const probe = vi.fn(async () => states.shift() ?? state());
  const client: ControlClient = { baseUrl: 'http://127.0.0.1:8787', probe, apiGet: async () => ({}) as never };
  const supervisor = createControlSupervisor({
    log,
    client,
    minIntervalMs: 100,
    now: () => clock,
  });
  return { supervisor, probe, lines, tick: (ms: number) => (clock += ms) };
}

describe('control supervisor', () => {
  it('caches a recent probe instead of hammering the server', async () => {
    const h = harness([state(), state()]);
    await h.supervisor.status();
    await h.supervisor.status();
    expect(h.probe).toHaveBeenCalledTimes(1);

    h.tick(150);
    await h.supervisor.status();
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it('logs a transition once, not on every poll', async () => {
    const h = harness([
      state({ status: 'unreachable', detail: 'control service unreachable (ECONNREFUSED)' }),
      state({ status: 'unreachable', detail: 'control service unreachable (ECONNREFUSED)' }),
      state({ status: 'connected' }),
    ]);

    await h.supervisor.status();
    h.tick(150);
    await h.supervisor.status();
    h.tick(150);
    await h.supervisor.status();

    const messages = h.lines.map((line) => JSON.parse(line));
    expect(messages).toHaveLength(2);
    expect(messages[0].level).toBe('WARN');
    expect(messages[0].controlStatus).toBe('unreachable');
    expect(messages[1].level).toBe('INFO');
    expect(messages[1].controlStatus).toBe('connected');
  });

  it('shares a single in-flight probe between concurrent callers', async () => {
    const h = harness([state()]);
    const [a, b] = await Promise.all([h.supervisor.status(), h.supervisor.status()]);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(h.supervisor.lastState()?.status).toBe('connected');
  });
});
