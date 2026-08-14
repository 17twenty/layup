import { beforeEach, describe, expect, it } from 'vitest';
import {
  INPUT_PROTOCOL_VERSION,
  TYPE_CONTROL_REVOKE,
  TYPE_KEY_DOWN,
  TYPE_POINTER_DOWN,
  type ControlMessage,
} from '@layup/protocol';
import { CHANNEL_INPUT } from '../core/data-channels';
import { createInputGuard, type InputGuard } from '../core/input-guard';
import { createInputSender } from '../core/input-sender';
import { createRemoteControl, type RemoteControl } from '../core/remote-control';
import { createLogger } from './logging';
import { createEmergencyRevoke, EMERGENCY_REVOKE_SHORTCUT, type EmergencyRevoke } from './emergency-revoke';
import { createRemoteInputRouter, type RemoteInputRouter } from './remote-input';
import type { HelperClient, HelperResponse } from './helper-client';

const PRESENTER = 'm-presenter';
const GUEST = 'm-guest';
const DISPLAY = 'd-1';

let calls: Array<{ command: string; payload: unknown }>;
let broadcast: ControlMessage[];
let guard: InputGuard;
let control: RemoteControl;
let router: RemoteInputRouter;
let emergency: EmergencyRevoke;
let shortcuts: Map<string, () => void>;
let registerSucceeds = true;
let seq = 0;

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

function press(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    type: TYPE_POINTER_DOWN,
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

function keyDown(code: string) {
  seq += 1;
  return { type: TYPE_KEY_DOWN, v: INPUT_PROTOCOL_VERSION, membershipId: GUEST, code, seq };
}

beforeEach(() => {
  calls = [];
  broadcast = [];
  shortcuts = new Map();
  registerSucceeds = true;
  seq = 0;

  guard = createInputGuard({
    localMembershipId: PRESENTER,
    isPresenting: () => true,
    sharedDisplayId: () => DISPLAY,
    presenterMembershipId: () => PRESENTER,
    allowsScope: (scope) => control.isAllowed(scope),
  });
  control = createRemoteControl({
    membershipId: PRESENTER,
    guard,
    broadcast: (message) => broadcast.push(message),
    isPresenting: () => true,
  });
  router = createRemoteInputRouter({
    guard,
    helper: () => helper,
    displays: () => [{ displayId: DISPLAY, x: 0, y: 0, width: 1920, height: 1080 }],
    log: createLogger({ level: 'error', write: () => {} }),
  });
  emergency = createEmergencyRevoke({
    control,
    router,
    holders: () => [GUEST],
    log: createLogger({ level: 'error', write: () => {} }),
    register: (accelerator, handler) => {
      if (!registerSucceeds) return false;
      shortcuts.set(accelerator, handler);
      return true;
    },
    unregister: (accelerator) => void shortcuts.delete(accelerator),
  });

  control.setAllowed('pointer', true);
  control.setAllowed('keyboard', true);
  control.grant(GUEST, 'pointer');
  control.grant(GUEST, 'keyboard');
});

describe('emergency revoke', () => {
  it('ends everything from one shortcut, with nothing to confirm', async () => {
    await router.handle(press(), fromGuest);
    await router.handle(keyDown('MetaLeft'), fromGuest);
    expect(control.state().anyoneHasControl).toBe(true);
    calls = [];

    expect(emergency.arm()).toBe(true);
    // The OS calls this; there is no dialog in between.
    shortcuts.get(EMERGENCY_REVOKE_SHORTCUT)!();
    await router.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(control.state().grants).toEqual([]);
    expect(control.state().anyoneHasControl).toBe(false);
    // Held input is released, keys before buttons.
    expect(calls).toEqual([
      { command: 'key', payload: { code: 'MetaLeft', down: false } },
      { command: 'pointer.button', payload: { button: 'left', down: false } },
    ]);
    expect(router.dragging()).toBeUndefined();
    expect(router.typing()).toBeUndefined();
  });

  it('refuses the very next message, before anybody has been told', async () => {
    const result = await emergency.trigger('button');
    expect(result.revoked).toBe(2);

    // The local half runs first on purpose: a message that arrives late must
    // not be what stands between a person and their own machine.
    expect(await router.handle(press(), fromGuest)).toMatchObject({ injected: false });
    expect(guard.allows(GUEST, 'pointer')).toBe(false);
  });

  it('tells the remote peers, and their senders act on it', async () => {
    // The guest's own sender is the other half of this: it stops sending and
    // lets go of what it was holding.
    const sent: unknown[] = [];
    const sender = createInputSender({
      membershipId: GUEST,
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    for (const message of broadcast) sender.applyControl(message);
    sender.pointerDown({ displayId: DISPLAY, x: 0.5, y: 0.5, button: 'left' });
    sender.keyDown('ShiftLeft');
    expect(sender.scopes()).toEqual(['pointer', 'keyboard']);

    broadcast = [];
    await emergency.trigger('button');

    const revoke = broadcast.at(-1);
    expect(revoke).toMatchObject({ type: TYPE_CONTROL_REVOKE });
    // No target: everybody, at once.
    expect((revoke as { targetMembershipId?: string }).targetMembershipId).toBeUndefined();

    sent.length = 0;
    sender.applyControl(revoke as ControlMessage);
    expect(sender.scopes()).toEqual([]);
    expect(sender.held()).toEqual({ buttons: [], keys: [] });
    // It sent its own releases rather than leaving them dangling.
    expect(sent).toHaveLength(2);
  });

  it('keeps remote control out for a moment afterwards', async () => {
    await emergency.trigger('button');
    // A message already in flight cannot land as the presenter takes over.
    expect(router.localHasPriority()).toBe(true);
  });

  it('says so plainly when the OS will not give it the shortcut', () => {
    const lines: string[] = [];
    const noisy = createEmergencyRevoke({
      control,
      router,
      holders: () => [],
      log: createLogger({ level: 'warn', write: (line) => lines.push(line) }),
      register: () => false,
    });

    // A person who thinks they have a panic key that does nothing is worse off
    // than one who knows they do not - the on-screen button still works.
    expect(noisy.arm()).toBe(false);
    expect(noisy.armed()).toBe(false);
    expect(lines.join('\n')).toContain('could not be registered');
  });

  it('gives the shortcut back when it is disarmed', () => {
    emergency.arm();
    expect(shortcuts.has(EMERGENCY_REVOKE_SHORTCUT)).toBe(true);
    emergency.disarm();
    expect(shortcuts.has(EMERGENCY_REVOKE_SHORTCUT)).toBe(false);
    expect(emergency.armed()).toBe(false);
  });

  it('is safe to press when nobody has control', async () => {
    control.revokeAll();
    const result = await emergency.trigger('shortcut');
    expect(result).toEqual({ revoked: 0, cause: 'shortcut' });
  });
});
