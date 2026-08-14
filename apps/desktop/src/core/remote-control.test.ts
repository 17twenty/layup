import { beforeEach, describe, expect, it } from 'vitest';
import {
  INPUT_PROTOCOL_VERSION,
  TYPE_CONTROL_GRANT,
  TYPE_CONTROL_REVOKE,
  TYPE_POINTER_CLICK,
  type ControlMessage,
} from '@layup/protocol';
import { CHANNEL_INPUT } from './data-channels';
import { createInputGuard, type InputGuard } from './input-guard';
import { createRemoteControl, type RemoteControl } from './remote-control';

const PRESENTER = 'm-presenter';
const GUEST = 'm-guest';
const OTHER = 'm-other';
const DISPLAY = 'display-1';

let guard: InputGuard;
let control: RemoteControl;
let broadcast: ControlMessage[];
let released: Array<string | undefined>;
let presenting = true;
let seq = 0;

function click(membershipId = GUEST) {
  seq += 1;
  return {
    type: TYPE_POINTER_CLICK,
    v: INPUT_PROTOCOL_VERSION,
    membershipId,
    displayId: DISPLAY,
    x: 0.5,
    y: 0.5,
    button: 'left',
    seq,
  };
}

beforeEach(() => {
  presenting = true;
  seq = 0;
  broadcast = [];
  released = [];
  // The switch lives in the controller; the guard reads it. That is the wiring
  // the application uses, so it is the wiring under test.
  guard = createInputGuard({
    localMembershipId: PRESENTER,
    isPresenting: () => presenting,
    sharedDisplayId: () => DISPLAY,
    presenterMembershipId: () => PRESENTER,
    allowsScope: (scope) => control.isAllowed(scope),
  });
  control = createRemoteControl({
    membershipId: PRESENTER,
    guard,
    broadcast: (message) => broadcast.push(message),
    release: (membershipId) => released.push(membershipId),
    isPresenting: () => presenting,
  });
});

describe('presenter remote-control grants', () => {
  it('offers nothing until the presenter switches it on', () => {
    expect(control.state().allowed).toEqual({ pointer: false, keyboard: false });
    // Remote control is never the default state of somebody's machine.
    expect(control.grant(GUEST, 'pointer')).toBeUndefined();
    expect(guard.accept(click(), { membershipId: GUEST, channel: CHANNEL_INPUT })).toMatchObject({
      allowed: false,
    });
  });

  it('lets the presenter enable control and grant one participant', () => {
    control.setAllowed('pointer', true);
    const record = control.grant(GUEST, 'pointer');

    expect(record?.membershipId).toBe(GUEST);
    expect(control.state().grants).toEqual([{ membershipId: GUEST, scopes: ['pointer'] }]);
    expect(control.state().anyoneHasControl).toBe(true);
    expect(guard.accept(click(), { membershipId: GUEST, channel: CHANNEL_INPUT })).toMatchObject({
      allowed: true,
    });

    // The grant is announced so the guest's own UI knows.
    expect(broadcast.at(-1)).toMatchObject({
      type: TYPE_CONTROL_GRANT,
      targetMembershipId: GUEST,
      scope: 'pointer',
    });

    // Pointer control is not keyboard control.
    expect(control.grant(GUEST, 'keyboard')).toBeUndefined();
  });

  it('revokes one participant without touching the others', () => {
    control.setAllowed('pointer', true);
    control.grant(GUEST, 'pointer');
    control.grant(OTHER, 'pointer');

    expect(control.revoke(GUEST)).toBe(1);
    expect(control.state().grants).toEqual([{ membershipId: OTHER, scopes: ['pointer'] }]);
    expect(guard.accept(click(GUEST), { membershipId: GUEST, channel: CHANNEL_INPUT })).toMatchObject({
      allowed: false,
      reason: 'no-grant',
    });
    expect(guard.accept(click(OTHER), { membershipId: OTHER, channel: CHANNEL_INPUT })).toMatchObject({
      allowed: true,
    });

    // And whatever they were holding is let go.
    expect(released).toContain(GUEST);
    expect(broadcast.at(-1)).toMatchObject({ type: TYPE_CONTROL_REVOKE, targetMembershipId: GUEST });
  });

  it('withdraws every grant the moment control is switched off', () => {
    control.setAllowed('pointer', true);
    control.setAllowed('keyboard', true);
    control.grant(GUEST, 'pointer');
    control.grant(GUEST, 'keyboard');
    control.grant(OTHER, 'pointer');

    control.setAllowed('pointer', false);

    // Immediately, locally, before anybody is told.
    expect(control.state().grants).toEqual([{ membershipId: GUEST, scopes: ['keyboard'] }]);
    expect(guard.accept(click(), { membershipId: GUEST, channel: CHANNEL_INPUT })).toMatchObject({
      allowed: false,
    });
    expect(broadcast.at(-1)).toMatchObject({ type: TYPE_CONTROL_REVOKE, scope: 'pointer' });
    // Anything held goes too - a switch that leaves a button down is not off.
    expect(released.at(-1)).toBeUndefined();
  });

  it('revokes everybody in one step', () => {
    control.setAllowed('pointer', true);
    control.setAllowed('keyboard', true);
    control.grant(GUEST, 'pointer');
    control.grant(OTHER, 'keyboard');

    expect(control.revokeAll()).toBe(2);
    expect(control.state().grants).toEqual([]);
    expect(control.state().anyoneHasControl).toBe(false);
    // An untargeted revoke: everyone, at once.
    expect(broadcast.at(-1)).toEqual({
      type: TYPE_CONTROL_REVOKE,
      v: INPUT_PROTOCOL_VERSION,
      membershipId: PRESENTER,
      seq: expect.any(Number),
    });
  });

  it('needs no creator or moderator authority', () => {
    // Nothing in this module knows what a creator is: the only question asked
    // is whether this is my screen (ADR-0005).
    control.setAllowed('pointer', true);
    expect(control.grant(GUEST, 'pointer')).toBeDefined();

    presenting = false;
    expect(control.grant(OTHER, 'pointer')).toBeUndefined();
  });

  it('tells the interface whenever control changes', () => {
    const seen: boolean[] = [];
    const unsubscribe = control.subscribe((state) => seen.push(state.anyoneHasControl));

    control.setAllowed('pointer', true);
    control.grant(GUEST, 'pointer');
    control.revokeAll();
    unsubscribe();
    control.grant(GUEST, 'pointer');

    // on, granted, revoked - and nothing after unsubscribing.
    expect(seen).toEqual([false, true, false]);
  });
});
