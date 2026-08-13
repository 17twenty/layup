import { describe, expect, it, vi } from 'vitest';
import { createIceSupervisor } from './ice';
import { createLogger } from './logging';
import type { ControlClient, IceConfiguration } from '../core/control-client';

const config = (overrides: Partial<IceConfiguration> = {}): IceConfiguration => ({
  iceServers: [
    { urls: ['stun:stun.example:3478'] },
    { urls: ['turn:turn.example:3478'], username: '1800043200:usr_devnickx', credential: 'derived' },
  ],
  expiresAt: new Date(1_800_043_200_000).toISOString(),
  forceRelay: false,
  ...overrides,
});

function harness(options: {
  server?: Partial<IceConfiguration>;
  forceRelay?: boolean;
  fail?: boolean;
} = {}) {
  const lines: string[] = [];
  const turnCredentials = vi.fn(async () => {
    if (options.fail) throw new Error('control service unreachable');
    return config(options.server);
  });
  const supervisor = createIceSupervisor({
    client: { turnCredentials } as unknown as ControlClient,
    log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    now: () => 1_800_000_000_000,
    ...(options.forceRelay === undefined ? {} : { forceRelay: options.forceRelay }),
  });
  return { supervisor, turnCredentials, lines };
}

describe('ICE configuration', () => {
  it('uses the servers and credentials the control plane issued', async () => {
    const h = harness();
    const state = await h.supervisor.configuration();

    expect(state.iceServers).toHaveLength(2);
    expect(state.iceServers[1]?.username).toBe('1800043200:usr_devnickx');
    expect(state.forceRelay).toBe(false);
    expect(state.forcedBy).toBeUndefined();
  });

  it('caches until the credentials are close to expiring', async () => {
    const h = harness();
    await h.supervisor.configuration();
    await h.supervisor.configuration();
    expect(h.turnCredentials).toHaveBeenCalledTimes(1);

    // Credentials that expire inside the refresh margin are re-fetched.
    const stale = harness({ server: { expiresAt: new Date(1_800_000_030_000).toISOString() } });
    await stale.supervisor.configuration();
    await stale.supervisor.configuration();
    expect(stale.turnCredentials).toHaveBeenCalledTimes(2);
  });

  it('honours relay forced by organisation policy', async () => {
    const h = harness({ server: { forceRelay: true } });
    const state = await h.supervisor.configuration();
    expect(state).toMatchObject({ forceRelay: true, forcedBy: 'policy' });
  });

  it('honours relay forced locally, for testing the TURN path', async () => {
    const h = harness({ forceRelay: true });
    const state = await h.supervisor.configuration();
    expect(state).toMatchObject({ forceRelay: true, forcedBy: 'local' });
  });

  it('keeps forcing relay even when the configuration cannot be fetched', async () => {
    // Falling back to "direct only" would silently disable the very thing the
    // test mode exists to exercise.
    const h = harness({ fail: true, forceRelay: true });
    const state = await h.supervisor.configuration();
    expect(state.forceRelay).toBe(true);
    expect(state.iceServers[0]?.urls[0]).toMatch(/^stun:/);
  });

  it('never logs the TURN credential', async () => {
    const h = harness();
    await h.supervisor.configuration();
    const logged = h.lines.join('\n');
    expect(logged).not.toMatch(/derived|1800043200:usr_devnickx/);
    expect(JSON.parse(h.lines[0]!)).toMatchObject({ turnAuthIssued: true, servers: 2 });
  });
});
