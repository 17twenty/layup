/**
 * Sends remote-input actions to the presenter (SPEC.md §11, ADR-0008).
 *
 * Unlike cursor movement, nothing here is coalesced or dropped: every action is
 * consequential on somebody else's machine, so each one is sent exactly once on
 * the ordered, reliable channel, in the order it happened.
 *
 * The sender also refuses to send anything it has not been granted. That is not
 * the security boundary - the presenter's guard is, and it never trusts this
 * side - but a guest whose control was just revoked should stop sending
 * immediately rather than spray actions at a machine that is discarding them.
 */
import {
  INPUT_PROTOCOL_VERSION,
  MAX_WHEEL_DELTA,
  TYPE_CONTROL_GRANT,
  TYPE_KEY_DOWN,
  TYPE_KEY_UP,
  TYPE_LEASE_ACQUIRE,
  TYPE_LEASE_RELEASE,
  TYPE_POINTER_CLICK,
  TYPE_POINTER_DOWN,
  TYPE_POINTER_UP,
  TYPE_POINTER_WHEEL,
  clampNormalised,
  isPlausibleKeyCode,
  type ControlMessage,
  type ControlScope,
  type InputMessage,
  type PointerButton,
} from '@layup/protocol';
import { CHANNEL_INPUT } from './data-channels';

export interface InputSenderOptions {
  membershipId: string;
  /** Delivers one message. Returning false means the channel was not ready. */
  send: (message: InputMessage, channel: typeof CHANNEL_INPUT) => boolean;
  log?: { warn(message: string, fields?: Record<string, unknown>): void };
}

export interface InputSenderStats {
  sent: number;
  /** Actions refused because this participant holds no grant for them. */
  ungranted: number;
  /** Sends the channel would not accept. */
  refused: number;
  /** Actions rejected for their own content, e.g. an implausible key code. */
  invalid: number;
}

export interface InputSender {
  /** Scopes the presenter has granted us, as we last heard it. */
  scopes(): ControlScope[];
  /** Applies a control message received from the presenter. */
  applyControl(message: ControlMessage): void;
  pointerDown(input: PointerTarget & { button: PointerButton }): boolean;
  pointerUp(input: PointerTarget & { button: PointerButton }): boolean;
  pointerClick(input: PointerTarget & { button: PointerButton; clickCount?: number }): boolean;
  pointerWheel(input: PointerTarget & { deltaX: number; deltaY: number }): boolean;
  keyDown(code: string): boolean;
  keyUp(code: string): boolean;
  acquireLease(scope: ControlScope): boolean;
  releaseLease(scope: ControlScope): boolean;
  /** Releases everything this sender knows it is holding. */
  releaseHeld(): void;
  /** What is still held down here, for the caller's own indicator. */
  held(): { buttons: PointerButton[]; keys: string[] };
  stats(): InputSenderStats;
}

/** A position on the shared surface, normalised - never receiver pixels. */
export interface PointerTarget {
  displayId: string;
  x: number;
  y: number;
}

/**
 * A message as the caller supplies it: the envelope fields are the sender's to
 * fill in, never the caller's. Distributive so each variant keeps its own shape.
 */
type Draft<T> = T extends unknown ? Omit<T, 'v' | 'seq' | 'membershipId'> : never;

export function createInputSender(options: InputSenderOptions): InputSender {
  const stats: InputSenderStats = { sent: 0, ungranted: 0, refused: 0, invalid: 0 };
  const granted = new Set<ControlScope>();
  // What we have pressed and not released. Kept so a revoke or a disconnect can
  // let go rather than leaving a button or a modifier stuck down (SPEC.md §13.3).
  const heldButtons = new Map<string, PointerTarget & { button: PointerButton }>();
  const heldKeys = new Set<string>();
  let seq = 0;

  function emit(message: Draft<InputMessage>, scope?: ControlScope): boolean {
    if (scope && !granted.has(scope)) {
      stats.ungranted += 1;
      return false;
    }
    seq += 1;
    const full = {
      ...message,
      v: INPUT_PROTOCOL_VERSION,
      membershipId: options.membershipId,
      seq,
    } as InputMessage;

    if (!options.send(full, CHANNEL_INPUT)) {
      stats.refused += 1;
      return false;
    }
    stats.sent += 1;
    return true;
  }

  const position = (target: PointerTarget) => ({
    displayId: target.displayId,
    x: clampNormalised(target.x),
    y: clampNormalised(target.y),
  });

  const clampWheel = (delta: number) => {
    if (!Number.isFinite(delta)) return 0;
    const whole = Math.trunc(delta);
    return whole < -MAX_WHEEL_DELTA ? -MAX_WHEEL_DELTA : whole > MAX_WHEEL_DELTA ? MAX_WHEEL_DELTA : whole;
  };

  /**
   * Releases everything held, in reverse order of pressing, so a modifier held
   * over another key is the last thing to come up.
   *
   * These sends deliberately skip the grant check: a release must go out even
   * when control has just been revoked, or the key stays down.
   */
  function releaseHeld() {
    for (const code of [...heldKeys].reverse()) {
      emit({ type: TYPE_KEY_UP, code });
      heldKeys.delete(code);
    }
    for (const [button, target] of [...heldButtons.entries()]) {
      emit({ type: TYPE_POINTER_UP, ...position(target), button: target.button });
      heldButtons.delete(button);
    }
  }

  return {
    scopes: () => [...granted],

    applyControl(message) {
      if (message.type === TYPE_CONTROL_GRANT) {
        // No target means the presenter shared with the room, which includes
        // us; a named target is the exception, for putting one person back.
        if (message.targetMembershipId && message.targetMembershipId !== options.membershipId) return;
        granted.add(message.scope);
        return;
      }
      // A revoke aimed at everybody has no target; one aimed at somebody else
      // is not ours to act on.
      if (message.targetMembershipId && message.targetMembershipId !== options.membershipId) return;
      if (message.scope) granted.delete(message.scope);
      else granted.clear();
      // Let go of anything we were holding, immediately: control ending must
      // not leave a button or key down on the presenter's machine.
      releaseHeld();
    },

    pointerDown(input) {
      const sent = emit({ type: TYPE_POINTER_DOWN, ...position(input), button: input.button }, 'pointer');
      if (sent) heldButtons.set(input.button, { ...position(input), button: input.button });
      return sent;
    },

    pointerUp(input) {
      const sent = emit({ type: TYPE_POINTER_UP, ...position(input), button: input.button }, 'pointer');
      // Forget it either way: a button we could not release is worse tracked
      // than untracked, and the presenter releases everything on disconnect.
      heldButtons.delete(input.button);
      return sent;
    },

    pointerClick(input) {
      return emit(
        {
          type: TYPE_POINTER_CLICK,
          ...position(input),
          button: input.button,
          ...(input.clickCount ? { clickCount: Math.min(3, Math.max(1, Math.trunc(input.clickCount))) } : {}),
        },
        'pointer',
      );
    },

    pointerWheel(input) {
      return emit(
        {
          type: TYPE_POINTER_WHEEL,
          ...position(input),
          deltaX: clampWheel(input.deltaX),
          deltaY: clampWheel(input.deltaY),
        },
        'pointer',
      );
    },

    keyDown(code) {
      if (!isPlausibleKeyCode(code)) {
        // Never log the code itself: it is the shape of typed content
        // (SPEC.md §13.4).
        options.log?.warn('refused an implausible key code');
        stats.invalid += 1;
        return false;
      }
      const sent = emit({ type: TYPE_KEY_DOWN, code }, 'keyboard');
      if (sent) heldKeys.add(code);
      return sent;
    },

    keyUp(code) {
      if (!isPlausibleKeyCode(code)) {
        stats.invalid += 1;
        return false;
      }
      const sent = emit({ type: TYPE_KEY_UP, code }, 'keyboard');
      heldKeys.delete(code);
      return sent;
    },

    acquireLease: (scope) => emit({ type: TYPE_LEASE_ACQUIRE, scope }, scope),
    releaseLease: (scope) => emit({ type: TYPE_LEASE_RELEASE, scope }, scope),

    releaseHeld,

    held: () => ({
      buttons: [...heldButtons.values()].map((entry) => entry.button),
      keys: [...heldKeys],
    }),

    stats: () => ({ ...stats }),
  };
}
