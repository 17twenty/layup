/**
 * The presenter's control over their own machine (SPEC.md §7.3, ADR-0005).
 *
 * Two levels, and both belong to the presenter alone:
 *
 *   - a switch per scope - "Mouse + keyboard [ON/OFF]" - which is the state of
 *     the share itself;
 *   - a grant per participant, which is who may use it.
 *
 * Nothing here consults creator or moderator authority, because none applies: a
 * layup creator has no say over somebody else's keyboard. The only question
 * asked is "is this my screen?".
 *
 * Turning a switch off must take effect *now*, not when the far side notices:
 * every grant in that scope is withdrawn locally first - so the guard starts
 * refusing immediately, even from a peer that never receives the message - then
 * the revoke is announced, then anything held is released.
 */
import {
  INPUT_PROTOCOL_VERSION,
  TYPE_CONTROL_GRANT,
  TYPE_CONTROL_REVOKE,
  type ControlMessage,
  type ControlScope,
} from '@layup/protocol';
import type { ControlGrantRecord, InputGuard } from './input-guard';

export interface RemoteControlOptions {
  /** The presenter's own membership. */
  membershipId: string;
  /** Where grants actually live and are enforced. */
  guard: InputGuard;
  /** Announces a control message to every participant. */
  broadcast: (message: ControlMessage) => void;
  /**
   * Releases anything the named membership is holding on this machine - or
   * everybody's, with no argument. Control ending must never leave a button or
   * a modifier down (SPEC.md §13.3).
   */
  release?: (membershipId?: string) => void;
  /** Whether this machine is sharing right now. */
  isPresenting: () => boolean;
  newGrantId?: () => string;
}

export interface RemoteControlState {
  /** Whether this machine is offering remote control at all, per scope. */
  allowed: Record<ControlScope, boolean>;
  /** Who currently holds control, and of what. */
  grants: Array<{ membershipId: string; scopes: ControlScope[] }>;
  /** True when anybody at all can act on this machine - drives the indicator. */
  anyoneHasControl: boolean;
}

export interface RemoteControl {
  state(): RemoteControlState;
  /** Subscribes to state changes. Returns an unsubscribe function. */
  subscribe(listener: (state: RemoteControlState) => void): () => void;
  /** Turns a scope on or off for the whole share. */
  setAllowed(scope: ControlScope, allowed: boolean): void;
  /** Whether a scope is switched on. */
  isAllowed(scope: ControlScope): boolean;
  /** Gives one participant control of one scope. */
  grant(membershipId: string, scope: ControlScope): ControlGrantRecord | undefined;
  /** Withdraws one participant's control. Returns how many grants went. */
  revoke(membershipId: string, scope?: ControlScope): number;
  /** Withdraws everybody's control, in one step. */
  revokeAll(): number;
}

export function createRemoteControl(options: RemoteControlOptions): RemoteControl {
  const { guard, broadcast, membershipId } = options;
  // Off until the presenter says otherwise: remote control is never the
  // default state of somebody's machine.
  const allowed: Record<ControlScope, boolean> = { pointer: false, keyboard: false };
  const listeners = new Set<(state: RemoteControlState) => void>();
  let seq = 0;

  function state(): RemoteControlState {
    const byMembership = new Map<string, ControlScope[]>();
    for (const record of guard.grants()) {
      const scopes = byMembership.get(record.membershipId) ?? [];
      scopes.push(record.scope);
      byMembership.set(record.membershipId, scopes);
    }
    const grants = [...byMembership.entries()].map(([id, scopes]) => ({
      membershipId: id,
      scopes: scopes.sort(),
    }));
    return {
      allowed: { ...allowed },
      grants,
      anyoneHasControl: grants.length > 0,
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
      if (allowed[scope] === next) return;
      allowed[scope] = next;

      if (!next) {
        // Withdraw first, announce second. A participant who never receives the
        // message is still stopped, because the guard is what decides.
        guard.revoke({ scope });
        send({ type: TYPE_CONTROL_REVOKE, scope });
        options.release?.();
      }
      announce();
    },

    grant(target, scope) {
      // A scope that is switched off cannot be granted: the switch is the
      // presenter's answer about their machine, and a grant does not override
      // it.
      if (!allowed[scope]) return undefined;
      if (!options.isPresenting()) return undefined;

      const record = guard.grant(target, scope);
      if (!record) return undefined;

      send({
        type: TYPE_CONTROL_GRANT,
        targetMembershipId: target,
        scope,
        grantId: record.grantId,
      });
      announce();
      return record;
    },

    revoke(target, scope) {
      const removed = guard.revoke({ membershipId: target, ...(scope ? { scope } : {}) });
      // Announce even when nothing was held: a client that thinks it has
      // control and is wrong must be corrected.
      send({
        type: TYPE_CONTROL_REVOKE,
        targetMembershipId: target,
        ...(scope ? { scope } : {}),
      });
      options.release?.(target);
      announce();
      return removed;
    },

    revokeAll() {
      const removed = guard.revoke();
      // No target: everybody, at once. This is the shape the emergency stop
      // uses (SPEC.md §13.3).
      send({ type: TYPE_CONTROL_REVOKE });
      options.release?.();
      announce();
      return removed;
    },
  };
}
