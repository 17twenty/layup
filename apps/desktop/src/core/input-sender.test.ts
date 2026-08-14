import { beforeEach, describe, expect, it } from 'vitest';
import {
  INPUT_PROTOCOL_VERSION,
  MAX_WHEEL_DELTA,
  TYPE_CONTROL_GRANT,
  TYPE_CONTROL_REVOKE,
  TYPE_KEY_UP,
  TYPE_POINTER_UP,
  decodeInput,
  type ControlMessage,
  type InputMessage,
} from '@layup/protocol';
import { CHANNEL_INPUT } from './data-channels';
import { createInputGuard } from './input-guard';
import { createInputSender, type InputSender } from './input-sender';

const GUEST = 'm-guest';
const PRESENTER = 'm-presenter';
const DISPLAY = 'display-1';

let sent: Array<{ message: InputMessage; channel: string }>;
let accepting = true;
let sender: InputSender;

const grant = (scope: 'pointer' | 'keyboard'): ControlMessage => ({
  type: TYPE_CONTROL_GRANT,
  v: INPUT_PROTOCOL_VERSION,
  membershipId: PRESENTER,
  targetMembershipId: GUEST,
  scope,
  grantId: `g-${scope}`,
  seq: 1,
});

beforeEach(() => {
  sent = [];
  accepting = true;
  sender = createInputSender({
    membershipId: GUEST,
    send: (message, channel) => {
      if (!accepting) return false;
      sent.push({ message, channel });
      return true;
    },
  });
});

describe('remote input sender', () => {
  it('sends every action on the reliable channel, in order', () => {
    sender.applyControl(grant('pointer'));
    sender.pointerDown({ displayId: DISPLAY, x: 0.5, y: 0.5, button: 'left' });
    sender.pointerUp({ displayId: DISPLAY, x: 0.5, y: 0.5, button: 'left' });
    sender.pointerWheel({ displayId: DISPLAY, x: 0.5, y: 0.5, deltaX: 0, deltaY: -3 });

    expect(sent.map((entry) => entry.channel)).toEqual([CHANNEL_INPUT, CHANNEL_INPUT, CHANNEL_INPUT]);
    // Sequence numbers increase, so the presenter can refuse a replay.
    expect(sent.map((entry) => entry.message.seq)).toEqual([1, 2, 3]);
    // And everything sent is a message the protocol accepts.
    for (const entry of sent) expect(() => decodeInput(entry.message)).not.toThrow();
  });

  it('sends nothing it has not been granted', () => {
    sender.pointerDown({ displayId: DISPLAY, x: 0.5, y: 0.5, button: 'left' });
    sender.keyDown('KeyA');
    expect(sent).toHaveLength(0);
    expect(sender.stats().ungranted).toBe(2);

    // Pointer control is not keyboard control.
    sender.applyControl(grant('pointer'));
    expect(sender.keyDown('KeyA')).toBe(false);
    expect(sender.pointerDown({ displayId: DISPLAY, x: 0.5, y: 0.5, button: 'left' })).toBe(true);
  });

  it('lets go of everything the moment control is revoked', () => {
    sender.applyControl(grant('pointer'));
    sender.applyControl(grant('keyboard'));
    sender.pointerDown({ displayId: DISPLAY, x: 0.2, y: 0.2, button: 'left' });
    sender.keyDown('MetaLeft');
    sender.keyDown('KeyA');
    expect(sender.held()).toEqual({ buttons: ['left'], keys: ['MetaLeft', 'KeyA'] });

    sent = [];
    sender.applyControl({
      type: TYPE_CONTROL_REVOKE,
      v: INPUT_PROTOCOL_VERSION,
      membershipId: PRESENTER,
      seq: 2,
    });

    // The releases still go out, even though the grant is gone: otherwise the
    // presenter is left holding Cmd (SPEC.md §13.3).
    expect(sent.map((entry) => entry.message.type)).toEqual([TYPE_KEY_UP, TYPE_KEY_UP, TYPE_POINTER_UP]);
    // Reverse press order, so the modifier comes up last.
    expect(sent.map((entry) => (entry.message as { code?: string }).code)).toEqual([
      'KeyA',
      'MetaLeft',
      undefined,
    ]);
    expect(sender.held()).toEqual({ buttons: [], keys: [] });
    expect(sender.scopes()).toEqual([]);
  });

  it('ignores control aimed at somebody else', () => {
    sender.applyControl({ ...grant('pointer'), targetMembershipId: 'm-other' });
    expect(sender.scopes()).toEqual([]);

    sender.applyControl(grant('pointer'));
    sender.applyControl({
      type: TYPE_CONTROL_REVOKE,
      v: INPUT_PROTOCOL_VERSION,
      membershipId: PRESENTER,
      targetMembershipId: 'm-other',
      seq: 3,
    });
    expect(sender.scopes()).toEqual(['pointer']);
  });

  it('bounds what it will put on the wire', () => {
    sender.applyControl(grant('pointer'));
    sender.applyControl(grant('keyboard'));

    // A coordinate outside the surface is clamped, not sent as-is: the protocol
    // would refuse it and the action would be lost entirely.
    sender.pointerClick({ displayId: DISPLAY, x: 1.5, y: -0.5, button: 'left' });
    expect(sent[0]?.message).toMatchObject({ x: 1, y: 0 });

    // A runaway wheel event cannot scroll a thousand pages.
    sender.pointerWheel({ displayId: DISPLAY, x: 0.5, y: 0.5, deltaX: 0, deltaY: 99_999 });
    expect(sent[1]?.message).toMatchObject({ deltaY: MAX_WHEEL_DELTA });
    sender.pointerWheel({ displayId: DISPLAY, x: 0.5, y: 0.5, deltaX: Number.NaN, deltaY: 1.5 });
    expect(sent[2]?.message).toMatchObject({ deltaX: 0, deltaY: 1 });

    // Typed content is not a key code, and never reaches the wire.
    expect(sender.keyDown('my bank password')).toBe(false);
    expect(sender.stats().invalid).toBe(1);
    expect(JSON.stringify(sent)).not.toContain('password');
  });

  it('counts what the channel would not take', () => {
    sender.applyControl(grant('pointer'));
    accepting = false;
    expect(sender.pointerClick({ displayId: DISPLAY, x: 0.5, y: 0.5, button: 'left' })).toBe(false);
    expect(sender.stats().refused).toBe(1);
  });

  it("produces messages the presenter's guard accepts", () => {
    // The two halves are written separately and must meet in the middle.
    const guard = createInputGuard({
      localMembershipId: PRESENTER,
      isPresenting: () => true,
      sharedDisplayId: () => DISPLAY,
      presenterMembershipId: () => PRESENTER,
    });
    guard.grant(GUEST, 'pointer');
    guard.grant(GUEST, 'keyboard');

    sender.applyControl(grant('pointer'));
    sender.applyControl(grant('keyboard'));
    sender.pointerDown({ displayId: DISPLAY, x: 0.1, y: 0.9, button: 'right' });
    sender.pointerUp({ displayId: DISPLAY, x: 0.1, y: 0.9, button: 'right' });
    sender.keyDown('KeyA');
    sender.keyUp('KeyA');

    expect(sent).toHaveLength(4);
    for (const entry of sent) {
      expect(
        guard.accept(JSON.parse(JSON.stringify(entry.message)), {
          membershipId: GUEST,
          channel: entry.channel,
        }),
      ).toMatchObject({ allowed: true });
    }
  });
});
