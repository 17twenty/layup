import { beforeEach, describe, expect, it } from 'vitest';
import { INPUT_PROTOCOL_VERSION, TYPE_KEY_DOWN, TYPE_KEY_UP } from '@layup/protocol';
import { CHANNEL_INPUT } from '../core/data-channels';
import { createInputGuard, type InputGuard } from '../core/input-guard';
import { createInputLeases, type InputLeases } from '../core/input-lease';
import { createLogger } from './logging';
import { createRemoteInputRouter, type RemoteInputRouter } from './remote-input';
import type { HelperClient, HelperResponse } from './helper-client';

const KARL = 'm-karl';
const SAM = 'm-sam';
const PRESENTER = 'm-presenter';
const DISPLAY = 'd-1';

let calls: Array<{ command: string; payload: unknown }>;
let guard: InputGuard;
let leases: InputLeases;
let router: RemoteInputRouter;
let clock = 0;
/** Which scopes this machine is sharing with the layup. */
let shared: Set<'pointer' | 'keyboard'>;
const sequences = new Map<string, number>();

const helper: HelperClient = {
  connect: async () => {},
  send: async (command, payload): Promise<HelperResponse> => {
    calls.push({ command, payload });
    return { ok: true };
  },
  capabilities: async () => undefined,
  close: () => {},
  connected: () => true,
};

function key(code: string, down: boolean, membershipId = KARL) {
  const next = (sequences.get(membershipId) ?? 0) + 1;
  sequences.set(membershipId, next);
  return {
    type: down ? TYPE_KEY_DOWN : TYPE_KEY_UP,
    v: INPUT_PROTOCOL_VERSION,
    membershipId,
    code,
    seq: next,
  };
}

const from = (membershipId: string) => ({ membershipId, channel: CHANNEL_INPUT });

beforeEach(() => {
  shared = new Set();
  calls = [];
  clock = 1_000;
  sequences.clear();
  guard = createInputGuard({
    localMembershipId: PRESENTER,
    isPresenting: () => true,
    sharedDisplayId: () => DISPLAY,
    presenterMembershipId: () => PRESENTER,
    allowsScope: (scope) => shared.has(scope),
  });
  shared.add('keyboard');
  
  leases = createInputLeases({ idleTimeoutMs: 2_000, now: () => clock });
  router = createRemoteInputRouter({
    guard,
    helper: () => helper,
    displays: () => [{ displayId: DISPLAY, x: 0, y: 0, width: 1920, height: 1080 }],
    log: createLogger({ level: 'error', write: () => {} }),
    leases,
  });
});

describe('keyboard focus lease', () => {
  it('gives the keyboard to whoever starts typing', async () => {
    expect(await router.handle(key('KeyA', true), from(KARL))).toEqual({ injected: true });
    expect(router.typing()).toBe(KARL);
    expect(calls).toEqual([{ command: 'key', payload: { code: 'KeyA', down: true } }]);
  });

  it('handles a competing typist predictably: first one keeps it', async () => {
    await router.handle(key('KeyA', true), from(KARL));
    calls = [];

    // Two people typing into one editor is not collaboration, it is a mess.
    expect(await router.handle(key('KeyB', true, SAM), from(SAM))).toEqual({
      injected: false,
      reason: 'busy',
    });
    expect(calls).toEqual([]);
    expect(router.typing()).toBe(KARL);
  });

  it('renews the lease with every keystroke', async () => {
    await router.handle(key('KeyA', true), from(KARL));

    for (let step = 0; step < 5; step += 1) {
      clock += 1_500;
      await router.handle(key('KeyA', false), from(KARL));
      await router.handle(key('KeyA', true), from(KARL));
      expect(router.expireLeases()).toBe(0);
    }
    // Typing is a run of presses with gaps; losing the keyboard between two
    // keystrokes would let somebody else type into the middle of a word.
    expect(router.typing()).toBe(KARL);
  });

  it('releases the keyboard after a pause, and cleans up held modifiers', async () => {
    await router.handle(key('MetaLeft', true), from(KARL));
    await router.handle(key('KeyA', true), from(KARL));
    calls = [];

    clock += 2_000;
    expect(router.expireLeases()).toBe(1);
    await router.settle();

    // Reverse press order: the modifier held over the other key comes up last.
    expect(calls).toEqual([
      { command: 'key', payload: { code: 'KeyA', down: false } },
      { command: 'key', payload: { code: 'MetaLeft', down: false } },
    ]);
    expect(router.typing()).toBeUndefined();

    // And the keyboard is free for the next person.
    expect(await router.handle(key('KeyB', true, SAM), from(SAM))).toEqual({ injected: true });
  });

  it('releases held keys when a participant disconnects', async () => {
    await router.handle(key('ShiftLeft', true), from(KARL));
    await router.handle(key('KeyZ', true), from(KARL));
    calls = [];

    await router.releaseFor(KARL);

    expect(calls).toEqual([
      { command: 'key', payload: { code: 'KeyZ', down: false } },
      { command: 'key', payload: { code: 'ShiftLeft', down: false } },
    ]);
    expect(router.typing()).toBeUndefined();
  });

  it('lets go of Shift when control is revoked mid-word', async () => {
    await router.handle(key('ShiftLeft', true), from(KARL));
    calls = [];

    // A revoke does not wait for the sender to be polite about it: the
    // alternative is Shift stuck down on the presenter's machine (SPEC.md §13.3).
    leases.releaseAll(KARL, 'revoked');
    await router.settle();
    expect(calls).toEqual([{ command: 'key', payload: { code: 'ShiftLeft', down: false } }]);

    // And the sender's own key-up afterwards is still accepted rather than
    // refused as somebody else's business.
    calls = [];
    expect(await router.handle(key('ShiftLeft', false), from(KARL))).toEqual({ injected: true });
    expect(calls).toEqual([{ command: 'key', payload: { code: 'ShiftLeft', down: false } }]);
  });

  it('keeps the pointer and the keyboard independent', async () => {
    shared.add('pointer');
    await router.handle(key('KeyA', true), from(KARL));

    // Karl typing must not stop Sam clicking.
    const click = {
      type: 'pointer.click',
      v: INPUT_PROTOCOL_VERSION,
      membershipId: SAM,
      displayId: DISPLAY,
      x: 0.5,
      y: 0.5,
      button: 'left',
      seq: 99,
    };
    expect(await router.handle(click, from(SAM))).toEqual({ injected: true });
    expect(router.typing()).toBe(KARL);
  });
});
