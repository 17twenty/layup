import { beforeEach, describe, expect, it } from 'vitest';
import {
  INPUT_PROTOCOL_VERSION,
  TYPE_CONTROL_GRANT,
  TYPE_KEY_DOWN,
  TYPE_POINTER_CLICK,
  TYPE_POINTER_DOWN,
} from '@layup/protocol';
import { CHANNEL_CURSOR, CHANNEL_INPUT } from './data-channels';
import { createInputGuard, type InputGuard } from './input-guard';

const GUEST = 'm-guest';
const PRESENTER = 'm-presenter';
const DISPLAY = 'display-1';

let presenting = true;
let sharedDisplay: string | undefined = DISPLAY;
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
  seq = 0;
  guard = createInputGuard({
    localMembershipId: PRESENTER,
    isPresenting: () => presenting,
    sharedDisplayId: () => sharedDisplay,
    presenterMembershipId: () => PRESENTER,
    now: () => 1_000,
  });
});

describe('remote input guard', () => {
  it('refuses everything until the presenter grants control', () => {
    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: false, reason: 'no-grant' });

    guard.grant(GUEST, 'pointer');
    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: true });

    // Pointer and keyboard are granted separately.
    expect(
      guard.accept(
        { type: TYPE_KEY_DOWN, v: INPUT_PROTOCOL_VERSION, membershipId: GUEST, code: 'KeyA', seq: 50 },
        fromGuest,
      ),
    ).toMatchObject({ allowed: false, reason: 'no-grant' });
  });

  it('revokes in one step, including everyone at once', () => {
    guard.grant(GUEST, 'pointer');
    guard.grant('m-other', 'keyboard');
    expect(guard.grants()).toHaveLength(2);

    expect(guard.revoke({ membershipId: GUEST })).toBe(1);
    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: false, reason: 'no-grant' });

    // The emergency stop takes no argument and leaves nothing behind.
    guard.grant(GUEST, 'pointer');
    expect(guard.revoke()).toBe(2);
    expect(guard.grants()).toHaveLength(0);
  });

  it('will not accept an action from the cursor channel', () => {
    // cursor-fast throws packets away by design. A click that arrived there is
    // not a click we can be sure about (ADR-0008).
    guard.grant(GUEST, 'pointer');
    expect(guard.accept(click(), { membershipId: GUEST, channel: CHANNEL_CURSOR })).toMatchObject({
      allowed: false,
      reason: 'wrong-channel',
    });
  });

  it('will not let a participant act as somebody else', () => {
    guard.grant(GUEST, 'pointer');
    guard.grant('m-other', 'pointer');

    // Arrived on the guest's connection, but claims to be another membership.
    expect(guard.accept(click({ membershipId: 'm-other' }), fromGuest)).toMatchObject({
      allowed: false,
      reason: 'membership-mismatch',
    });
  });

  it('refuses a replayed action', () => {
    guard.grant(GUEST, 'pointer');
    const first = click();
    expect(guard.accept(first, fromGuest)).toMatchObject({ allowed: true });
    // The same message, captured and sent again.
    expect(guard.accept(first, fromGuest)).toMatchObject({ allowed: false, reason: 'replayed' });
    expect(guard.accept(click({ seq: 0 }), fromGuest)).toMatchObject({ allowed: false, reason: 'replayed' });
  });

  it('refuses malformed messages without interpreting them', () => {
    guard.grant(GUEST, 'pointer');
    for (const raw of [
      undefined,
      'pointer.click',
      { type: 'pointer.click' },
      click({ button: 'extra' }),
      click({ x: 42 }),
      click({ v: 99 }),
    ]) {
      expect(guard.accept(raw, fromGuest)).toMatchObject({ allowed: false, reason: 'malformed' });
    }
  });

  it('ends every grant when the share does', () => {
    guard.grant(GUEST, 'pointer');
    expect(guard.allows(GUEST, 'pointer')).toBe(true);

    // Stopping the share ends control immediately - the grant was for that
    // share, not for the machine (SPEC.md §7.3).
    presenting = false;
    expect(guard.allows(GUEST, 'pointer')).toBe(false);
    expect(guard.accept(click(), fromGuest)).toMatchObject({ allowed: false, reason: 'not-presenting' });

    // Sharing a different display does not resurrect it either.
    presenting = true;
    sharedDisplay = 'display-2';
    expect(guard.allows(GUEST, 'pointer')).toBe(false);
    expect(guard.accept(click({ displayId: 'display-2' }), fromGuest)).toMatchObject({
      allowed: false,
      reason: 'wrong-display',
    });
  });

  it('refuses an action aimed at a display that is not being shared', () => {
    guard.grant(GUEST, 'pointer');
    expect(guard.accept(click({ displayId: 'display-9' }), fromGuest)).toMatchObject({
      allowed: false,
      reason: 'wrong-display',
    });
  });

  it('will not let a participant grant themselves control', () => {
    const forged = {
      type: TYPE_CONTROL_GRANT,
      v: INPUT_PROTOCOL_VERSION,
      membershipId: GUEST,
      targetMembershipId: GUEST,
      scope: 'pointer',
      grantId: 'g-forged',
      seq: 1,
    };
    expect(guard.accept(forged, fromGuest)).toMatchObject({ allowed: false, reason: 'not-presenter' });
    expect(guard.grants()).toHaveLength(0);

    // Nor can the presenter grant control of a machine to itself.
    expect(guard.grant(PRESENTER, 'pointer')).toBeUndefined();
  });

  it('accepts a grant from the presenter when we are the guest', () => {
    // The same guard runs on both sides; on the guest it is how the local UI
    // learns it has control.
    const guest = createInputGuard({
      localMembershipId: GUEST,
      isPresenting: () => false,
      sharedDisplayId: () => DISPLAY,
      presenterMembershipId: () => PRESENTER,
    });

    const decision = guest.accept(
      {
        type: TYPE_CONTROL_GRANT,
        v: INPUT_PROTOCOL_VERSION,
        membershipId: PRESENTER,
        targetMembershipId: GUEST,
        scope: 'pointer',
        grantId: 'g-1',
        seq: 1,
      },
      { membershipId: PRESENTER, channel: CHANNEL_INPUT },
    );
    expect(decision).toMatchObject({ allowed: true });

    // But a guest still cannot be told to act by another guest.
    expect(
      guest.accept(
        {
          type: TYPE_CONTROL_GRANT,
          v: INPUT_PROTOCOL_VERSION,
          membershipId: 'm-other',
          targetMembershipId: GUEST,
          scope: 'pointer',
          grantId: 'g-2',
          seq: 2,
        },
        { membershipId: 'm-other', channel: CHANNEL_INPUT },
      ),
    ).toMatchObject({ allowed: false, reason: 'not-presenter' });
  });

  it('forgets a membership that leaves', () => {
    guard.grant(GUEST, 'pointer');
    guard.accept(click(), fromGuest);

    guard.forget(GUEST);
    expect(guard.grants()).toHaveLength(0);

    // And a rejoining membership is not locked out by the old sequence.
    guard.grant(GUEST, 'pointer');
    expect(guard.accept(click({ seq: 1 }), fromGuest)).toMatchObject({ allowed: true });
  });

  it('reports a refusal without echoing what was refused', () => {
    guard.grant(GUEST, 'keyboard');
    presenting = false;
    const decision = guard.accept(
      { type: TYPE_KEY_DOWN, v: INPUT_PROTOCOL_VERSION, membershipId: GUEST, code: 'KeyQ', seq: 1 },
      fromGuest,
    );
    // The reason is a fixed vocabulary. A refusal that quoted the key would put
    // typed content into whatever logs it (SPEC.md §13.4).
    expect(decision).toEqual({ allowed: false, reason: 'not-presenting' });
    expect(JSON.stringify(decision)).not.toContain('KeyQ');
  });

  it('accepts a pointer press only from the granted membership', () => {
    guard.grant(GUEST, 'pointer');
    const other = { membershipId: 'm-other', channel: CHANNEL_INPUT };
    expect(
      guard.accept(click({ membershipId: 'm-other', type: TYPE_POINTER_DOWN }), other),
    ).toMatchObject({ allowed: false, reason: 'no-grant' });
  });
});
