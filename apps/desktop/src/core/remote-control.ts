/**
 * How the presenter shares their machine (SPEC.md §7.3, ADR-0005).
 *
 * There are two switches, and that is the whole model: **Mouse** and
 * **Keyboard**, on or off, for the layup. Sharing control is a mode, not a list
 * of permissions handed out person by person - people in a layup are already
 * people you chose to be in a room with, and several of them acting at once,
 * funnelled through this machine's one mouse and keyboard, is the point of the
 * feature rather than a risk to be administered.
 *
 * One person can still be stopped by name. That is deliberately the exception,
 * and it is a *stop* - the answer to somebody doing something alarming - not the
 * withdrawal of a permission that had to be granted first.
 *
 * Both switches start off. Turning one off takes effect *now*: the guard stops
 * accepting before anybody is told, and anything held is released.
 */
import {
  INPUT_PROTOCOL_VERSION,
  TYPE_CONTROL_GRANT,
  TYPE_CONTROL_REVOKE,
  type ControlMessage,
  type ControlScope,
} from '@layup/protocol';
import type { InputGuard } from './input-guard';

export interface RemoteControlOptions {
  /** The presenter's own membership. */
  membershipId: string;
  /** Where the mode is enforced. */
  guard: InputGuard;
  /** Announces a control message to every participant. */
  broadcast: (message: ControlMessage) => void;
  /**
   * Releases anything the named membership is holding - or everybody's, with no
   * argument. Control ending must never leave a button or a modifier down
   * (SPEC.md §13.3).
   */
  release?: (membershipId?: string) => void;
  /** Whether this machine is sharing right now. */
  isPresenting: () => boolean;
  newGrantId?: () => string;
}

export interface RemoteControlState {
  /** What this machine is sharing, per scope. */
  allowed: Record<ControlScope, boolean>;
  /** People stopped by name while the scope is otherwise shared. */
  stopped: Array<{ membershipId: string; scopes: ControlScope[] }>;
  /** True when anybody at all can act on this machine. */
  anyoneHasControl: boolean;
}

export interface RemoteControl {
  state(): RemoteControlState;
  subscribe(listener: (state: RemoteControlState) => void): () => void;
  /** Shares - or stops sharing - one scope with the whole layup. */
  setAllowed(scope: ControlScope, allowed: boolean): void;
  isAllowed(scope: ControlScope): boolean;
  /** Stops one person, while everybody else carries on. */
  stop(membershipId: string): void;
  /** Lets a stopped person back in. */
  resume(membershipId: string): void;
  /** Stops everything, in one step. */
  stopAll(): number;
}

export function createRemoteControl(options: RemoteControlOptions): RemoteControl {
  const { guard, broadcast, membershipId } = options;
  // Off until the presenter says otherwise: a machine is not shared by default.
  const allowed: Record<ControlScope, boolean> = { pointer: false, keyboard: false };
  const listeners = new Set<(state: RemoteControlState) => void>();
  let counter = 0;
  const newGrantId = options.newGrantId ?? (() => `grant-${(counter += 1)}`);
  let seq = 0;

  function state(): RemoteControlState {
    const byMembership = new Map<string, ControlScope[]>();
    for (const stop of guard.stopped()) {
      const scopes = byMembership.get(stop.membershipId) ?? [];
      scopes.push(stop.scope);
      byMembership.set(stop.membershipId, scopes);
    }
    return {
      allowed: { ...allowed },
      stopped: [...byMembership.entries()].map(([id, scopes]) => ({
        membershipId: id,
        scopes: scopes.sort(),
      })),
      anyoneHasControl: options.isPresenting() && (allowed.pointer || allowed.keyboard),
    };
  }

  function announce() {
    const snapshot = state();
    for (const listener of listeners) listener(snapshot);
  }

  function send(message: Omit<ControlMessage, 'v' | 'seq' | 'membershipId'>) {
    seq += 1;
    broadcast({ ...message, v: INPUT_PROTOCOL_VERSION, membershipId, seq } as ControlMessage);
  }

  return {
    state,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    isAllowed: (scope) => allowed[scope],

    setAllowed(scope, next) {
      if (allowed[scope] === next || !options.isPresenting()) return;
      allowed[scope] = next;

      if (next) {
        // Shared with the room: no target, because nobody is being singled out.
        send({ type: TYPE_CONTROL_GRANT, scope, grantId: newGrantId() });
      } else {
        // Withdraw first, announce second: a participant who never receives the
        // message is still stopped, because the guard is what decides. Old
        // individual stops go with it - they meant nothing once nobody is
        // allowed, and would silently outlive the switch.
        guard.clearStops();
        send({ type: TYPE_CONTROL_REVOKE, scope });
        options.release?.();
      }
      announce();
    },

    stop(target) {
      guard.stop(target);
      send({ type: TYPE_CONTROL_REVOKE, targetMembershipId: target });
      options.release?.(target);
      announce();
    },

    resume(target) {
      guard.resume(target);
      for (const scope of ['pointer', 'keyboard'] as const) {
        if (allowed[scope]) {
          send({
            type: TYPE_CONTROL_GRANT,
            targetMembershipId: target,
            scope,
            grantId: newGrantId(),
          });
        }
      }
      announce();
    },

    stopAll() {
      const wasOn = (allowed.pointer ? 1 : 0) + (allowed.keyboard ? 1 : 0);
      allowed.pointer = false;
      allowed.keyboard = false;
      guard.clearStops();
      // No target and no scope: everything, at once (SPEC.md §13.3).
      send({ type: TYPE_CONTROL_REVOKE });
      options.release?.();
      announce();
      return wasOn;
    },
  };
}
