import { beforeEach, describe, expect, it } from 'vitest';
import {
  INPUT_PROTOCOL_VERSION,
  TYPE_CONTROL_GRANT,
  TYPE_KEY_DOWN,
  TYPE_POINTER_CLICK,
  TYPE_POINTER_DOWN,
  type ControlScope,
} from '@layup/protocol';
import { CHANNEL_CURSOR, CHANNEL_INPUT } from './data-channels';
import { createInputGuard, type InputGuard } from './input-guard';

const GUEST = 'm-guest';
const OTHER = 'm-other';
const PRESENTER = 'm-presenter';
const DISPLAY = 'display-1';

let presenting = true;
let sharedDisplay: string | undefined = DISPLAY;
let shared: Set<ControlScope>;
let guard: InputGuard;
let seq = 0;

function click(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    type: TYPE_POINTER_CLICK,
    v: INPUT_PROTOCOL_VERSION,
    membershipId: GUEST,
    displayId: DISPLAY,
    x: 0.25,
    y: 0.75,
    button: 'left',
    seq,
    ...overrides,
  };
}

const fromGuest = { membershipId: GUEST, channel: CHANNEL_INPUT };

beforeEach(() => {
  presenting = true;
  sharedDisplay = DISPLAY;
  shared = new Set();
  seq = 0;
  guard = createInputGuard({
    localMembershipId: PRESENTER,
    isPresenting: () => presenting,
    sharedDisplayId: () => sharedDisplay,
    presenterMembershipId: () => PRESENTER,
    allowsScope: (scope) => shared.has(scope),
  });
});

describe('remote input guard', () => {
  it('refuses everything until the scope is shared, then allows the room', () => {
    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: false, reason: 'scope-off' });

    shared.add('pointer');

    // Shared means shared: nobody had to be named first.
    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: true });
    expect(guard.accept(click({ membershipId: OTHER }), { membershipId: OTHER, channel: CHANNEL_INPUT })).toMatchObject(
      { allowed: true },
    );

    // The mouse being shared says nothing about the keyboard.
    expect(
      guard.accept(
        { type: TYPE_KEY_DOWN, v: INPUT_PROTOCOL_VERSION, membershipId: GUEST, code: 'KeyA', seq: 50 },
        fromGuest,
      ),
    ).toMatchObject({ allowed: false, reason: 'scope-off' });
  });

  it('stops one person while everybody else carries on', () => {
    shared.add('pointer');
    guard.stop(GUEST);

    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: false, reason: 'stopped' });
    expect(
      guard.accept(click({ membershipId: OTHER }), { membershipId: OTHER, channel: CHANNEL_INPUT }),
    ).toMatchObject({ allowed: true });
    expect(guard.stopped()).toEqual([
      expect.objectContaining({ membershipId: GUEST, scope: 'pointer' }),
      expect.objectContaining({ membershipId: GUEST, scope: 'keyboard' }),
    ]);

    guard.resume(GUEST);
    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: true });
  });

  it('never lets the presenter act on their own machine through the guard', () => {
    shared.add('pointer');
    // Their own hands are not remote input, and a message claiming to be them
    // is somebody else lying.
    expect(guard.allows(PRESENTER, 'pointer')).toBe(false);
  });

  it('will not accept an action from the cursor channel', () => {
    shared.add('pointer');
    // cursor-fast throws packets away by design. A click that arrived there is
    // not a click we can be sure about (ADR-0008).
    expect(guard.accept(click(), { membershipId: GUEST, channel: CHANNEL_CURSOR })).toMatchObject({
      allowed: false,
      reason: 'wrong-channel',
    });
  });

  it('will not let a participant act as somebody else', () => {
    shared.add('pointer');
    expect(guard.accept(click({ membershipId: OTHER }), fromGuest)).toMatchObject({
      allowed: false,
      reason: 'membership-mismatch',
    });
  });

  it('refuses a replayed action', () => {
    shared.add('pointer');
    const first = click();
    expect(guard.accept(first, fromGuest)).toMatchObject({ allowed: true });
    expect(guard.accept(first, fromGuest)).toMatchObject({ allowed: false, reason: 'replayed' });
    expect(guard.accept(click({ seq: 0 }), fromGuest)).toMatchObject({ allowed: false, reason: 'replayed' });
  });

  it('refuses malformed messages without interpreting them', () => {
    shared.add('pointer');
    for (const raw of [undefined, 'pointer.click', { type: 'pointer.click' }, click({ button: 'extra' }), click({ x: 42 }), click({ v: 99 })]) {
      expect(guard.accept(raw, fromGuest)).toMatchObject({ allowed: false, reason: 'malformed' });
    }
  });

  it('ends when the share does', () => {
    shared.add('pointer');
    expect(guard.allows(GUEST, 'pointer')).toBe(true);

    // Sharing control is about a screen you are showing, not about your machine
    // for ever after (SPEC.md §7.3).
    presenting = false;
    expect(guard.allows(GUEST, 'pointer')).toBe(false);
    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: false, reason: 'not-presenting' });

    presenting = true;
    sharedDisplay = 'display-2';
    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: false, reason: 'wrong-display' });
  });

  it('will not let a participant share your machine on your behalf', () => {
    const forged = {
      type: TYPE_CONTROL_GRANT,
      v: INPUT_PROTOCOL_VERSION,
      membershipId: GUEST,
      scope: 'pointer',
      grantId: 'g-forged',
      seq: 1,
    };
    expect(guard.accept(forged, fromGuest)).toMatchObject({ allowed: false, reason: 'not-presenter' });
  });

  it('accepts the presenter telling us what is shared, when we are the guest', () => {
    const guest = createInputGuard({
      localMembershipId: GUEST,
      isPresenting: () => false,
      sharedDisplayId: () => DISPLAY,
      presenterMembershipId: () => PRESENTER,
      allowsScope: () => false,
    });

    expect(
      guest.accept(
        {
          type: TYPE_CONTROL_GRANT,
          v: INPUT_PROTOCOL_VERSION,
          membershipId: PRESENTER,
          scope: 'pointer',
          grantId: 'g-1',
          seq: 1,
        },
        { membershipId: PRESENTER, channel: CHANNEL_INPUT },
      ),
    ).toMatchObject({ allowed: true });

    // But not another guest claiming to speak for the presenter.
    expect(
      guest.accept(
        {
          type: TYPE_CONTROL_GRANT,
          v: INPUT_PROTOCOL_VERSION,
          membershipId: OTHER,
          scope: 'pointer',
          grantId: 'g-2',
          seq: 2,
        },
        { membershipId: OTHER, channel: CHANNEL_INPUT },
      ),
    ).toMatchObject({ allowed: false, reason: 'not-presenter' });
  });

  it('forgets a membership that leaves, including that it was stopped', () => {
    shared.add('pointer');
    guard.stop(GUEST);
    guard.accept(click(), fromGuest);

    guard.forget(GUEST);

    // A membership that comes back is a new one: it should not inherit a
    // decision made about somebody who left.
    expect(guard.stopped()).toEqual([]);
    expect(guard.accept(click({ seq: 1, type: TYPE_POINTER_DOWN }), fromGuest)).toMatchObject({
      allowed: true,
    });
  });

  it('reports a refusal without echoing what was refused', () => {
    presenting = false;
    const decision = guard.accept(
      { type: TYPE_KEY_DOWN, v: INPUT_PROTOCOL_VERSION, membershipId: GUEST, code: 'KeyQ', seq: 1 },
      fromGuest,
    );
    expect(decision).toEqual({ allowed: false, reason: 'not-presenting' });
    expect(JSON.stringify(decision)).not.toContain('KeyQ');
  });
});
