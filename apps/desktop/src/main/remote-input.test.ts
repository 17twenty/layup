import { beforeEach, describe, expect, it } from 'vitest';
import {
  INPUT_PROTOCOL_VERSION,
  TYPE_CURSOR_MOVE,
  TYPE_KEY_DOWN,
  TYPE_POINTER_CLICK,
  TYPE_POINTER_DOWN,
  TYPE_POINTER_UP,
  TYPE_POINTER_WHEEL,
} from '@layup/protocol';
import { CHANNEL_CURSOR, CHANNEL_INPUT } from '../core/data-channels';
import { createInputGuard, type InputGuard } from '../core/input-guard';
import { createInputLeases } from '../core/input-lease';
import { createLogger } from './logging';
import { createRemoteInputRouter, type RemoteInputRouter } from './remote-input';
import type { HelperClient, HelperResponse } from './helper-client';

const GUEST = 'm-guest';
const OTHER = 'm-other';
const PRESENTER = 'm-presenter';
const DISPLAY = 'd-1';
const displays = [{ displayId: DISPLAY, x: 0, y: 0, width: 1920, height: 1080 }];

let calls: Array<{ command: string; payload: unknown }>;
let guard: InputGuard;
let router: RemoteInputRouter;
let helperRunning = true;
let seq = 0;
let clock = 0;
let leases: ReturnType<typeof createInputLeases>;

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

const fromGuest = { membershipId: GUEST, channel: CHANNEL_INPUT };
const fromOther = { membershipId: OTHER, channel: CHANNEL_INPUT };

function down(overrides: Record<string, unknown> = {}) {
  return click({ type: TYPE_POINTER_DOWN, ...overrides });
}

function up(overrides: Record<string, unknown> = {}) {
  return click({ type: TYPE_POINTER_UP, ...overrides });
}

function click(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    type: TYPE_POINTER_CLICK,
    v: INPUT_PROTOCOL_VERSION,
    membershipId: GUEST,
    displayId: DISPLAY,
    x: 0.25,
    y: 0.5,
    button: 'left',
    seq,
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  helperRunning = true;
  seq = 0;
  clock = 1_000;
  guard = createInputGuard({
    localMembershipId: PRESENTER,
    isPresenting: () => true,
    sharedDisplayId: () => DISPLAY,
    presenterMembershipId: () => PRESENTER,
  });
  leases = createInputLeases({ idleTimeoutMs: 2_000, now: () => clock });
  router = createRemoteInputRouter({
    guard,
    helper: () => (helperRunning ? helper : undefined),
    displays: () => displays,
    log: createLogger({ level: 'error', write: () => {} }),
    leases,
  });
});

describe('remote click and wheel path', () => {
  it("clicks where the sender aimed, in the presenter's pixels", async () => {
    guard.grant(GUEST, 'pointer');
    expect(await router.handle(click(), fromGuest)).toEqual({ injected: true });

    // A quarter across a 1920 display, halfway down 1080.
    expect(calls).toEqual([
      { command: 'pointer.move', payload: { x: 480, y: 540 } },
      { command: 'pointer.button', payload: { button: 'left', down: true } },
      { command: 'pointer.button', payload: { button: 'left', down: false } },
    ]);
  });

  it('positions before pressing', async () => {
    guard.grant(GUEST, 'pointer');
    await router.handle(click({ x: 1, y: 1 }), fromGuest);
    // A button posted at the old position clicks whatever used to be there.
    expect(calls[0]).toEqual({ command: 'pointer.move', payload: { x: 1919, y: 1079 } });
  });

  it('sends a double-click as two presses in one place', async () => {
    guard.grant(GUEST, 'pointer');
    await router.handle(click({ clickCount: 2, button: 'right' }), fromGuest);

    expect(calls.filter((call) => call.command === 'pointer.move')).toHaveLength(1);
    expect(calls.filter((call) => call.command === 'pointer.button')).toHaveLength(4);
  });

  it('scrolls under the pointer', async () => {
    guard.grant(GUEST, 'pointer');
    seq += 1;
    const wheel = {
      type: TYPE_POINTER_WHEEL,
      v: INPUT_PROTOCOL_VERSION,
      membershipId: GUEST,
      displayId: DISPLAY,
      x: 0.5,
      y: 0.5,
      deltaX: 0,
      deltaY: -3,
      seq,
    };
    expect(await router.handle(wheel, fromGuest)).toEqual({ injected: true });
    expect(calls).toEqual([
      { command: 'pointer.move', payload: { x: 960, y: 540 } },
      { command: 'pointer.wheel', payload: { deltaX: 0, deltaY: -3 } },
    ]);
  });

  it("drops a revoked participant's actions before anything is aimed", async () => {
    guard.grant(GUEST, 'pointer');
    await router.handle(click(), fromGuest);
    calls = [];

    guard.revoke({ membershipId: GUEST });
    expect(await router.handle(click(), fromGuest)).toEqual({ injected: false, reason: 'no-grant' });
    // Nothing reached the OS - not even a pointer move.
    expect(calls).toEqual([]);
    expect(router.stats()).toMatchObject({ refused: 1 });
  });

  it('never moves the OS pointer for a synthetic cursor', async () => {
    // Cursors are overlays. They arrive on their own channel, and the guard
    // refuses them outright - so a moving cursor cannot drag the real pointer
    // around the presenter's machine (SPEC.md §8.1).
    guard.grant(GUEST, 'pointer');
    const cursor = {
      type: TYPE_CURSOR_MOVE,
      membershipId: GUEST,
      displayId: DISPLAY,
      x: 0.9,
      y: 0.9,
      seq: 1,
    };

    expect(await router.handle(cursor, { membershipId: GUEST, channel: CHANNEL_CURSOR })).toEqual({
      injected: false,
      reason: 'wrong-channel',
    });
    // And even offered on the input channel it is not an input message.
    expect(await router.handle(cursor, fromGuest)).toEqual({ injected: false, reason: 'malformed' });
    expect(calls).toEqual([]);
  });

  it('sends a key as a key, never as a pointer action', async () => {
    // The keyboard has its own grant and its own lease; what it must never do
    // is move or press the pointer on its way through.
    guard.grant(GUEST, 'keyboard');
    const result = await router.handle(
      { type: TYPE_KEY_DOWN, v: INPUT_PROTOCOL_VERSION, membershipId: GUEST, code: 'KeyA', seq: 1 },
      fromGuest,
    );
    expect(result).toEqual({ injected: true });
    expect(calls).toEqual([{ command: 'key', payload: { code: 'KeyA', down: true } }]);
  });

  it('stays usable when the helper is not running', async () => {
    guard.grant(GUEST, 'pointer');
    helperRunning = false;
    expect(await router.handle(click(), fromGuest)).toEqual({ injected: false, reason: 'no-helper' });
    expect(router.stats()).toMatchObject({ unavailable: 1 });
  });

  it('refuses to guess at an unknown display', async () => {
    guard.grant(GUEST, 'pointer');
    // The share moved to a display this router does not know about.
    const result = await router.handle(click(), fromGuest);
    expect(result).toEqual({ injected: true });

    const other = createRemoteInputRouter({
      guard,
      helper: () => helper,
      displays: () => [],
      log: createLogger({ level: 'error', write: () => {} }),
    });
    calls = [];
    expect(await other.handle(click(), fromGuest)).toEqual({
      injected: false,
      reason: 'unknown-display',
    });
    expect(calls).toEqual([]);
  });

  it('gives a drag to whoever started it', async () => {
    guard.grant(GUEST, 'pointer');
    guard.grant(OTHER, 'pointer');

    expect(await router.handle(down(), fromGuest)).toEqual({ injected: true });
    expect(router.dragging()).toBe(GUEST);

    // Somebody else's destructive action waits rather than fighting the drag.
    calls = [];
    expect(await router.handle(down({ membershipId: OTHER }), fromOther)).toEqual({
      injected: false,
      reason: 'busy',
    });
    expect(await router.handle(click({ membershipId: OTHER }), fromOther)).toEqual({
      injected: false,
      reason: 'busy',
    });
    expect(calls).toEqual([]);
    expect(router.stats()).toMatchObject({ busy: 2 });
  });

  it('hands the pointer back on mouse-up', async () => {
    guard.grant(GUEST, 'pointer');
    guard.grant(OTHER, 'pointer');

    await router.handle(down(), fromGuest);
    await router.handle(up(), fromGuest);
    expect(router.dragging()).toBeUndefined();

    expect(await router.handle(down({ membershipId: OTHER }), fromOther)).toEqual({ injected: true });
  });

  it('does not leave a button down when a drag times out', async () => {
    guard.grant(GUEST, 'pointer');
    await router.handle(down(), fromGuest);
    calls = [];

    // The peer stopped sending without disconnecting: from here that is
    // indistinguishable from vanishing, and the button must not stay down.
    clock += 2_000;
    expect(router.expireLeases()).toBe(1);
    await router.settle();

    expect(calls).toEqual([{ command: 'pointer.button', payload: { button: 'left', down: false } }]);
    expect(router.dragging()).toBeUndefined();
  });

  it('lets go of everything when a participant disconnects', async () => {
    guard.grant(GUEST, 'pointer');
    await router.handle(down({ button: 'right' }), fromGuest);
    calls = [];

    await router.releaseFor(GUEST);

    expect(calls).toEqual([{ command: 'pointer.button', payload: { button: 'right', down: false } }]);
    expect(router.dragging()).toBeUndefined();
  });

  it('keeps a slow drag alive while it is still moving', async () => {
    guard.grant(GUEST, 'pointer');
    await router.handle(down(), fromGuest);

    for (let step = 0; step < 5; step += 1) {
      clock += 1_500;
      expect(await router.handle(click(), fromGuest)).toEqual({ injected: true });
      expect(router.expireLeases()).toBe(0);
    }
    expect(router.dragging()).toBe(GUEST);
  });

  it('reports refusals without ever logging what was sent', async () => {
    const lines: string[] = [];
    const noisy = createRemoteInputRouter({
      guard,
      helper: () => helper,
      displays: () => displays,
      log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });

    await noisy.handle(
      { type: TYPE_KEY_DOWN, v: INPUT_PROTOCOL_VERSION, membershipId: GUEST, code: 'KeyQ', seq: 1 },
      fromGuest,
    );
    expect(lines.join('\n')).not.toContain('KeyQ');
    expect(lines.join('\n')).toContain('no-grant');
  });
});
