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

const from = (membershipId: string) => ({ membershipId, channel: CHANNEL_INPUT });

beforeEach(() => {
  presenting = true;
  seq = 0;
  broadcast = [];
  released = [];
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

describe('sharing control of your own machine', () => {
  it('shares nothing until the presenter says so', () => {
    expect(control.state().allowed).toEqual({ pointer: false, keyboard: false });
    expect(control.state().anyoneHasControl).toBe(false);
    expect(guard.accept(click(), from(GUEST))).toMatchObject({ allowed: false });
  });

  it('shares with the room, not with a list of people', () => {
    control.setAllowed('pointer', true);

    // Everybody in the layup, without anybody being named.
    expect(guard.accept(click(GUEST), from(GUEST))).toMatchObject({ allowed: true });
    expect(guard.accept(click(OTHER), from(OTHER))).toMatchObject({ allowed: true });
    expect(control.state().anyoneHasControl).toBe(true);

    // The announcement carries no target, for the same reason.
    const message = broadcast.at(-1) as { type: string; targetMembershipId?: string; scope?: string };
    expect(message).toMatchObject({ type: TYPE_CONTROL_GRANT, scope: 'pointer' });
    expect(message.targetMembershipId).toBeUndefined();

    // The mouse says nothing about the keyboard.
    expect(control.isAllowed('keyboard')).toBe(false);
  });

  it('stops one person without stopping the room', () => {
    control.setAllowed('pointer', true);
    control.stop(GUEST);

    expect(guard.accept(click(GUEST), from(GUEST))).toMatchObject({ allowed: false, reason: 'stopped' });
    expect(guard.accept(click(OTHER), from(OTHER))).toMatchObject({ allowed: true });
    expect(released).toContain(GUEST);
    expect(broadcast.at(-1)).toMatchObject({ type: TYPE_CONTROL_REVOKE, targetMembershipId: GUEST });
    expect(control.state().stopped).toEqual([
      { membershipId: GUEST, scopes: ['keyboard', 'pointer'] },
    ]);

    control.resume(GUEST);
    expect(guard.accept(click(GUEST), from(GUEST))).toMatchObject({ allowed: true });
    expect(control.state().stopped).toEqual([]);
  });

  it('takes effect the moment a switch goes off', () => {
    control.setAllowed('pointer', true);
    control.setAllowed('keyboard', true);
    control.setAllowed('pointer', false);

    // Locally first, before anybody is told.
    expect(guard.accept(click(), from(GUEST))).toMatchObject({ allowed: false, reason: 'scope-off' });
    expect(broadcast.at(-1)).toMatchObject({ type: TYPE_CONTROL_REVOKE, scope: 'pointer' });
    expect(released.at(-1)).toBeUndefined();
    // Keyboard is untouched: they are separate answers.
    expect(control.isAllowed('keyboard')).toBe(true);
  });

  it('forgets individual stops when sharing is switched off', () => {
    control.setAllowed('pointer', true);
    control.stop(GUEST);
    control.setAllowed('pointer', false);
    control.setAllowed('pointer', true);

    // A stop meant "not you, while everyone else can". It should not quietly
    // outlive the sharing it was an exception to.
    expect(control.state().stopped).toEqual([]);
    expect(guard.accept(click(), from(GUEST))).toMatchObject({ allowed: true });
  });

  it('stops everything in one step', () => {
    control.setAllowed('pointer', true);
    control.setAllowed('keyboard', true);

    expect(control.stopAll()).toBe(2);
    expect(control.state()).toMatchObject({
      allowed: { pointer: false, keyboard: false },
      anyoneHasControl: false,
    });
    expect(broadcast.at(-1)).toEqual({
      type: TYPE_CONTROL_REVOKE,
      v: INPUT_PROTOCOL_VERSION,
      membershipId: PRESENTER,
      seq: expect.any(Number),
    });
  });

  it('needs no creator or moderator authority, only a screen of your own', () => {
    // Nothing here knows what a creator is: the only question is whether this
    // is my screen (ADR-0005).
    presenting = false;
    control.setAllowed('pointer', true);
    expect(control.isAllowed('pointer')).toBe(false);
  });

  it('tells the interface whenever the mode changes', () => {
    const seen: boolean[] = [];
    const unsubscribe = control.subscribe((state) => seen.push(state.anyoneHasControl));

    control.setAllowed('pointer', true);
    control.stopAll();
    unsubscribe();
    control.setAllowed('pointer', true);

    expect(seen).toEqual([true, false]);
  });
});
