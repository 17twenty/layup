import { beforeEach, describe, expect, it } from 'vitest';
import { INPUT_PROTOCOL_VERSION, TYPE_KEY_DOWN, TYPE_POINTER_DOWN, TYPE_POINTER_UP } from '@layup/protocol';
import { CHANNEL_INPUT } from '../core/data-channels';
import { createInputGuard, type InputGuard } from '../core/input-guard';
import { createInputLeases, type InputLeases } from '../core/input-lease';
import { createLocalInputWatcher } from './local-input-watcher';
import { createLogger } from './logging';
import { createRemoteInputRouter, type RemoteInputRouter } from './remote-input';
import type { HelperClient, HelperResponse } from './helper-client';

const GUEST = 'm-guest';
const PRESENTER = 'm-presenter';
const DISPLAY = 'd-1';

let calls: Array<{ command: string; payload: unknown }>;
let guard: InputGuard;
let leases: InputLeases;
let router: RemoteInputRouter;
let clock = 0;
let seq = 0;
/** Which scopes this machine is sharing with the layup. */
let shared: Set<'pointer' | 'keyboard'>;

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
const log = createLogger({ level: 'error', write: () => {} });

function action(type: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    type,
    v: INPUT_PROTOCOL_VERSION,
    membershipId: GUEST,
    displayId: DISPLAY,
    x: 0.5,
    y: 0.5,
    button: 'left',
    seq,
    ...overrides,
  };
}

/** A key message carries a code and nothing else - no display, no position. */
function keyAction(code: string, down = true) {
  seq += 1;
  return {
    type: down ? TYPE_KEY_DOWN : 'key.up',
    v: INPUT_PROTOCOL_VERSION,
    membershipId: GUEST,
    code,
    seq,
  };
}

beforeEach(() => {
  shared = new Set();
  calls = [];
  clock = 1_000;
  seq = 0;
  guard = createInputGuard({
    localMembershipId: PRESENTER,
    isPresenting: () => true,
    sharedDisplayId: () => DISPLAY,
    presenterMembershipId: () => PRESENTER,
    allowsScope: (scope) => shared.has(scope),
  });
  shared.add('pointer');
  shared.add('keyboard');
  leases = createInputLeases({ idleTimeoutMs: 10_000, now: () => clock });
  router = createRemoteInputRouter({
    guard,
    helper: () => helper,
    displays: () => [{ displayId: DISPLAY, x: 0, y: 0, width: 1920, height: 1080 }],
    log,
    leases,
    localPriorityMs: 1_500,
    now: () => clock,
  });
});

describe('local input priority', () => {
  it('takes the machine back the moment the presenter touches it', async () => {
    await router.handle(action(TYPE_POINTER_DOWN), fromGuest);
    expect(router.dragging()).toBe(GUEST);
    calls = [];

    router.localInput();
    await router.settle();

    // The remote drag ends and its button is released: the presenter should
    // never have to wrestle their own pointer back.
    expect(router.dragging()).toBeUndefined();
    expect(calls).toEqual([{ command: 'pointer.button', payload: { button: 'left', down: false } }]);

    // And remote actions are refused while they carry on working.
    expect(await router.handle(action('pointer.click'), fromGuest)).toEqual({
      injected: false,
      reason: 'local-input',
    });
    expect(await router.handle(keyAction('KeyA'), fromGuest)).toEqual({
      injected: false,
      reason: 'local-input',
    });
    expect(router.stats()).toMatchObject({ preempted: 2 });
  });

  it('gives control back on its own, without anybody asking', async () => {
    router.localInput();
    expect(router.localHasPriority()).toBe(true);

    // Long enough to finish a sentence or a drag, short enough that control
    // resumes without a negotiation.
    clock += 1_500;
    expect(router.localHasPriority()).toBe(false);
    expect(await router.handle(action('pointer.click'), fromGuest)).toEqual({ injected: true });
  });

  it('notices the pointer moving somewhere it was not put', async () => {
    let cursor = { x: 100, y: 100 };
    let detected = 0;
    const watcher = createLocalInputWatcher({
      cursorPosition: () => cursor,
      expectedPosition: () => router.lastInjectedPoint(),
      remoteActive: () => router.dragging() !== undefined,
      onLocalInput: () => {
        detected += 1;
        router.localInput();
      },
      log,
    });

    // Nothing to compare against until remote control has moved the pointer.
    expect(watcher.poll()).toBe(false);

    await router.handle(action(TYPE_POINTER_DOWN), fromGuest);
    cursor = { x: 960, y: 540 }; // exactly where the router put it
    expect(watcher.poll()).toBe(false);

    // The presenter grabs the mouse.
    cursor = { x: 400, y: 300 };
    expect(watcher.poll()).toBe(true);
    expect(detected).toBe(1);
    expect(router.localHasPriority()).toBe(true);
  });

  it('does not fire on drift, or over and over once it has fired', async () => {
    let cursor = { x: 960, y: 540 };
    let fired = 0;
    const watcher = createLocalInputWatcher({
      cursorPosition: () => cursor,
      expectedPosition: () => router.lastInjectedPoint(),
      remoteActive: () => true,
      onLocalInput: () => {
        fired += 1;
      },
      log,
      tolerancePx: 2,
    });

    await router.handle(action(TYPE_POINTER_DOWN), fromGuest);
    // Exactly where remote control put it: nobody has touched anything.
    expect(watcher.poll()).toBe(false);

    // A pixel of drift from display scaling is not a person.
    cursor = { x: 961, y: 541 };
    expect(watcher.poll()).toBe(false);

    // A real move fires once; the pointer then sitting still does not keep
    // firing, or remote control could never resume.
    cursor = { x: 300, y: 300 };
    expect(watcher.poll()).toBe(true);
    expect(watcher.poll()).toBe(false);
    expect(fired).toBe(1);
  });

  it('polls only while somebody holds remote control', () => {
    const watcher = createLocalInputWatcher({
      cursorPosition: () => ({ x: 0, y: 0 }),
      expectedPosition: () => ({ x: 500, y: 500 }),
      remoteActive: () => false,
      onLocalInput: () => {
        throw new Error('should not fire');
      },
      log,
    });
    // An idle layup costs nothing and watches nobody.
    expect(watcher.poll()).toBe(false);
  });
});

describe('stuck input cleanup', () => {
  it('releases every held key and button when a participant disconnects', async () => {
    await router.handle(action(TYPE_POINTER_DOWN, { button: 'right' }), fromGuest);
    await router.handle(keyAction('ControlLeft'), fromGuest);
    await router.handle(keyAction('KeyC'), fromGuest);
    calls = [];

    await router.releaseFor(GUEST);

    // Keys first, in reverse press order, then buttons - nothing left down.
    expect(calls).toEqual([
      { command: 'key', payload: { code: 'KeyC', down: false } },
      { command: 'key', payload: { code: 'ControlLeft', down: false } },
      { command: 'pointer.button', payload: { button: 'right', down: false } },
    ]);
    expect(router.dragging()).toBeUndefined();
    expect(router.typing()).toBeUndefined();
  });

  it('forgets held state when the helper restarts rather than releasing into the new one', async () => {
    await router.handle(action(TYPE_POINTER_DOWN), fromGuest);
    await router.handle(keyAction('ShiftLeft'), fromGuest);
    calls = [];

    // The old helper died holding everything; its process exit released it. The
    // new one never pressed anything, so posting releases into it would be a
    // lie - and could interfere with the presenter's own input.
    router.helperRestarted();
    await router.settle();

    expect(calls).toEqual([]);
    expect(router.dragging()).toBeUndefined();
    expect(router.typing()).toBeUndefined();
    expect(router.lastInjectedPoint()).toBeUndefined();

    // And the next action starts cleanly.
    expect(await router.handle(action(TYPE_POINTER_UP), fromGuest)).toEqual({ injected: true });
  });
});
