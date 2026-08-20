import { describe, expect, it, vi } from 'vitest';
import { createControlSupervisor } from './control';
import { createLogger } from './logging';
import { ControlRequestError } from '../core/control-client';
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

function harness(states: ControlConnectionState[], meFails?: unknown, onCredentialsRejected?: () => void) {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  let clock = 0;
  const probe = vi.fn(async () => states.shift() ?? state());
  const unusedHere = async () => {
    throw new Error('not used by these tests');
  };
  const client: ControlClient = {
    baseUrl: 'http://127.0.0.1:8787',
    probe,
    apiGet: async () => ({}) as never,
    apiPost: unusedHere,
    apiDelete: unusedHere,
    createLayup: unusedHere,
    joinLayup: unusedHere,
    leaveLayup: unusedHere,
    getLayup: unusedHere,
    openLayups: unusedHere,
    turnCredentials: unusedHere,
    createLink: unusedHere,
    revokeLink: unusedHere,
    joinByLink: unusedHere,
    createRequest: unusedHere,
    listRequests: unusedHere,
    acceptRequest: unusedHere,
    declineRequest: unusedHere,
    currentLayup: unusedHere,
    startShare: unusedHere,
    stopShare: unusedHere,
    requestShare: unusedHere,
    cancelRequest: unusedHere,
    me: async () => {
      if (meFails !== undefined) throw meFails;
      return {
        user: { id: 'usr_devkarlx', displayName: 'Karl' },
        organisation: { id: 'org_devlayup', name: 'Layup Development' },
      };
    },
    directory: async () => ({
      organisation: { id: 'org_devlayup', name: 'Layup Development' },
      users: [{ id: 'usr_devkarlx', displayName: 'Karl' }],
    }),
  };
  const supervisor = createControlSupervisor({
    log,
    client,
    minIntervalMs: 100,
    now: () => clock,
    ...(onCredentialsRejected ? { onCredentialsRejected } : {}),
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

  it('resolves the development identity from the control plane', async () => {
    const h = harness([state()]);
    const identity = await h.supervisor.identity();
    expect(identity).toMatchObject({
      devUser: 'nick',
      resolved: true,
      userId: 'usr_devkarlx',
      organisationName: 'Layup Development',
    });
  });

  it('shares a single in-flight probe between concurrent callers', async () => {
    const h = harness([state()]);
    const [a, b] = await Promise.all([h.supervisor.status(), h.supervisor.status()]);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(h.supervisor.lastState()?.status).toBe('connected');
  });
});

/**
 * A dead token and a server that is not there (0.3.1, item 6).
 *
 * The app decided whether to show "Add a server" by asking *is a config
 * present*, never *does it work*, so a token the server had stopped
 * recognising left a permanently broken shell - "Identity unresolved", a
 * reconnect loop counting upwards - and the only way out was deleting
 * config.json by hand.
 *
 * Both directions are tested here because getting the second one wrong is much
 * worse than getting the first one wrong: an over-eager clear means flaky wifi
 * logs somebody out of a call they are in.
 */
describe('a credential the server no longer accepts', () => {
  it('is reported as a rejection, once, so the config can go', async () => {
    const rejected = vi.fn();
    const h = harness([], new ControlRequestError('unauthenticated: unrecognised token', 401), rejected);

    const identity = await h.supervisor.identity();

    expect(identity.resolved).toBe(false);
    expect(identity.credentialsRejected).toBe(true);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(identity.detail).toMatch(/unrecognised token/);
  });

  it('is a rejection for a refusal as well as for an unauthenticated answer', async () => {
    const rejected = vi.fn();
    const h = harness([], new ControlRequestError('forbidden', 403), rejected);
    expect((await h.supervisor.identity()).credentialsRejected).toBe(true);
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});

describe('a server that cannot be reached', () => {
  it('is not a rejection, so the config stays and the retrying goes on', async () => {
    const rejected = vi.fn();
    const h = harness([], new TypeError('fetch failed'), rejected);

    const identity = await h.supervisor.identity();

    // Unresolved is a normal state while a server is down. It is not a reason
    // to throw away the only credential this desktop has.
    expect(identity.resolved).toBe(false);
    expect(identity.credentialsRejected).toBeUndefined();
    expect(rejected).not.toHaveBeenCalled();
  });

  it('is not a rejection for a server that is up and broken', async () => {
    const rejected = vi.fn();
    const h = harness([], new ControlRequestError('internal', 500), rejected);
    expect((await h.supervisor.identity()).credentialsRejected).toBeUndefined();
    expect(rejected).not.toHaveBeenCalled();
  });

  it('keeps asking, rather than caching a failure for ever', async () => {
    const rejected = vi.fn();
    const h = harness([], new TypeError('fetch failed'), rejected);
    await h.supervisor.identity();
    await h.supervisor.identity();
    // Nothing here gives up: the answer may be different in five seconds.
    expect((await h.supervisor.identity()).resolved).toBe(false);
    expect(rejected).not.toHaveBeenCalled();
  });
});
