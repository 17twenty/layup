/**
 * The gate every remote input message passes before it can reach the OS
 * (SPEC.md §7.3, §13.3, ADR-0005, ADR-0008).
 *
 * The guard exists because a message cannot be allowed to carry its own
 * authority. `membershipId` says who is *claiming* to act; whether they may act
 * is decided here, from state the presenter's own machine owns:
 *
 *   - only the presenter's machine injects, and only while it is sharing;
 *   - the sender must hold a current grant for the scope they are using, issued
 *     locally by the presenter and revocable in one step;
 *   - the claimed membership must match the peer the message arrived from, so a
 *     participant cannot act as somebody else;
 *   - the message must arrive on `input-reliable`. Accepting a click from
 *     `cursor-fast` would mean accepting an action from a channel designed to
 *     throw packets away (ADR-0008);
 *   - sequence numbers move forwards only, so a captured action cannot be
 *     replayed.
 *
 * Nothing here injects anything. It decides, and says why - the wiring to the
 * native helper is P1-0509's job.
 */
import {
  decodeInput,
  isControlMessage,
  isLeaseMessage,
  isPointerMessage,
  scopeOf,
  type ControlScope,
  type InputMessage,
} from '@layup/protocol';
import { CHANNEL_INPUT } from './data-channels';

export interface ControlGrantRecord {
  grantId: string;
  /** Who may act. */
  membershipId: string;
  scope: ControlScope;
  /** Which shared display the grant is bound to. */
  displayId: string;
  issuedAtMs: number;
}

/** Why a message was refused. Deliberately coarse: never echoes the payload. */
export type RefusalReason =
  | 'wrong-channel'
  | 'malformed'
  | 'membership-mismatch'
  | 'not-presenting'
  | 'not-presenter'
  | 'no-grant'
  | 'wrong-display'
  | 'replayed';

export type InputDecision =
  | { allowed: true; message: InputMessage; grant?: ControlGrantRecord }
  | { allowed: false; reason: RefusalReason };

export interface InputGuardOptions {
  /** This machine's membership in the layup. */
  localMembershipId: string;
  /** Whether this machine is the one sharing its desktop right now. */
  isPresenting: () => boolean;
  /** The display currently being shared, if any. */
  sharedDisplayId: () => string | undefined;
  /** Who is presenting, for judging who may issue a grant. */
  presenterMembershipId?: () => string | undefined;
  now?: () => number;
  newGrantId?: () => string;
}

export interface InputGuard {
  /** Issues a grant. Only meaningful on the presenter's machine. */
  grant(membershipId: string, scope: ControlScope): ControlGrantRecord | undefined;
  /**
   * Revokes grants. With no filter it revokes everything - the emergency stop.
   * Returns how many grants were withdrawn.
   */
  revoke(filter?: { membershipId?: string; scope?: ControlScope; grantId?: string }): number;
  grants(): ControlGrantRecord[];
  /** Whether a membership may act in a scope right now. */
  allows(membershipId: string, scope: ControlScope): boolean;
  /** Judges one incoming message. */
  accept(raw: unknown, from: { membershipId: string; channel: string }): InputDecision;
  /** Forgets a membership entirely, e.g. when it leaves. */
  forget(membershipId: string): void;
}

export function createInputGuard(options: InputGuardOptions): InputGuard {
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const newGrantId = options.newGrantId ?? (() => `grant-${(counter += 1)}`);
  const grants = new Map<string, ControlGrantRecord>();
  // Highest sequence accepted per membership. Strictly increasing: unlike
  // cursor movement, an action replayed from an old capture must never be
  // acted on, and a genuine reconnect gets a fresh grant, which clears it.
  const sequences = new Map<string, number>();

  const key = (membershipId: string, scope: ControlScope) => `${membershipId}:${scope}`;

  const refuse = (reason: RefusalReason): InputDecision => ({ allowed: false, reason });

  return {
    grant(membershipId, scope) {
      // A presenter cannot grant control of a desktop they are not sharing, and
      // nobody can grant themselves control of their own machine.
      if (!options.isPresenting()) return undefined;
      const displayId = options.sharedDisplayId();
      if (!displayId) return undefined;
      if (membershipId === options.localMembershipId) return undefined;

      const record: ControlGrantRecord = {
        grantId: newGrantId(),
        membershipId,
        scope,
        displayId,
        issuedAtMs: now(),
      };
      grants.set(key(membershipId, scope), record);
      // A fresh grant starts a fresh sequence: the previous session's numbers
      // must not lock out the new one.
      sequences.delete(membershipId);
      return record;
    },

    revoke(filter = {}) {
      let removed = 0;
      for (const [entry, record] of [...grants.entries()]) {
        if (filter.membershipId && record.membershipId !== filter.membershipId) continue;
        if (filter.scope && record.scope !== filter.scope) continue;
        if (filter.grantId && record.grantId !== filter.grantId) continue;
        grants.delete(entry);
        removed += 1;
      }
      return removed;
    },

    grants: () => [...grants.values()],

    allows(membershipId, scope) {
      const record = grants.get(key(membershipId, scope));
      if (!record) return false;
      // A grant is bound to the share it was issued for: stopping the share, or
      // switching display, ends it (SPEC.md §7.3).
      return options.isPresenting() && options.sharedDisplayId() === record.displayId;
    },

    accept(raw, from) {
      if (from.channel !== CHANNEL_INPUT) return refuse('wrong-channel');

      let message: InputMessage;
      try {
        message = decodeInput(raw);
      } catch {
        return refuse('malformed');
      }

      // Who you are is decided by which peer connection the message arrived on,
      // not by what the message says about itself.
      if (message.membershipId !== from.membershipId) return refuse('membership-mismatch');

      const previous = sequences.get(message.membershipId);
      if (previous !== undefined && message.seq <= previous) return refuse('replayed');

      if (isControlMessage(message)) {
        // Only the presenter decides who has control. If we are presenting,
        // that is us, and a peer claiming otherwise is refused outright.
        if (options.isPresenting()) return refuse('not-presenter');
        const presenter = options.presenterMembershipId?.();
        if (!presenter || presenter !== message.membershipId) return refuse('not-presenter');
        sequences.set(message.membershipId, message.seq);
        return { allowed: true, message };
      }

      // Everything below acts on this machine, so it needs a grant.
      if (!options.isPresenting()) return refuse('not-presenting');

      const scope = isLeaseMessage(message) ? message.scope : scopeOf(message);
      if (!scope) return refuse('malformed');

      const record = grants.get(key(message.membershipId, scope));
      if (!record) return refuse('no-grant');

      const sharedDisplay = options.sharedDisplayId();
      if (!sharedDisplay || sharedDisplay !== record.displayId) return refuse('wrong-display');
      // A pointer action names the display it is aimed at; aiming at one that is
      // not being shared is not something to interpret generously.
      if (isPointerMessage(message) && message.displayId !== record.displayId) {
        return refuse('wrong-display');
      }

      sequences.set(message.membershipId, message.seq);
      return { allowed: true, message, grant: record };
    },

    forget(membershipId) {
      sequences.delete(membershipId);
      for (const [entry, record] of [...grants.entries()]) {
        if (record.membershipId === membershipId) grants.delete(entry);
      }
    },
  };
}
