/**
 * The gate every remote input message passes before it can reach the OS
 * (SPEC.md §7.3, §13.3, ADR-0005, ADR-0008).
 *
 * The guard exists because a message cannot be allowed to carry its own
 * authority. `membershipId` says who is *claiming* to act; whether they may act
 * is decided here, from state the presenter's own machine owns:
 *
 *   - only the presenter's machine injects, and only while it is sharing;
 *   - the scope must be **shared**. Control is a mode, not a list of
 *     permissions: the presenter shares the mouse with the layup, or does not.
 *     One person can still be stopped individually - that is the exception, and
 *     it is a *stop*, not the withdrawal of something granted by name;
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

/** Somebody the presenter has stopped while the scope is otherwise shared. */
export interface StoppedParticipant {
  membershipId: string;
  scope: ControlScope;
  stoppedAtMs: number;
}

/** Why a message was refused. Deliberately coarse: never echoes the payload. */
export type RefusalReason =
  | 'wrong-channel'
  | 'malformed'
  | 'membership-mismatch'
  | 'not-presenting'
  | 'not-presenter'
  | 'stopped'
  | 'scope-off'
  | 'wrong-display'
  | 'replayed'
  | 'guest';

export type InputDecision =
  | { allowed: true; message: InputMessage }
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
  /**
   * Whether a scope is switched on for this share at all (SPEC.md §7.3).
   *
   * Grants are withdrawn when a switch goes off, so this is belt and braces -
   * but the switch is the presenter's answer about their own machine, and it
   * should not depend on a bookkeeping step having run correctly.
   */
  allowsScope?: (scope: ControlScope) => boolean;
  /**
   * Whether a membership belongs to a guest: a browser visitor who arrived by
   * link, never someone with an account (the web-guests design, §8). A guest
   * is refused regardless of what the room-wide switches say - sharing
   * control with "the room" never meant a stranger holding a URL - and this
   * is the client-side half of that refusal. The server independently
   * refuses to ever issue the grant in the first place
   * (`httpapi/share_settings.go`); this exists in case one arrives anyway.
   *
   * The desktop client only ever sees membership ids on the wire, never user
   * ids, so it cannot answer this on its own - the caller supplies it from
   * `ParticipantDTO.isGuest`, which the server marks.
   */
  isGuestMembership?: (membershipId: string) => boolean;
  now?: () => number;
  newGrantId?: () => string;
}

export interface InputGuard {
  /**
   * Stops one participant in one scope, while it stays shared with everybody
   * else. With no scope, stops them in both.
   */
  stop(membershipId: string, scope?: ControlScope): number;
  /** Lets a stopped participant back in. */
  resume(membershipId: string, scope?: ControlScope): void;
  stopped(): StoppedParticipant[];
  /** Forgets every individual stop - used when a scope is switched off. */
  clearStops(): void;
  /** Whether a membership may act in a scope right now. */
  allows(membershipId: string, scope: ControlScope): boolean;
  /** Judges one incoming message. */
  accept(raw: unknown, from: { membershipId: string; channel: string }): InputDecision;
  /** Forgets a membership entirely, e.g. when it leaves. */
  forget(membershipId: string): void;
}

export function createInputGuard(options: InputGuardOptions): InputGuard {
  const now = options.now ?? (() => Date.now());
  // People the presenter has stopped by name. Everybody else is allowed
  // whenever the scope is shared: that is what "shared" means.
  const stops = new Map<string, StoppedParticipant>();
  // Highest sequence accepted per membership. Strictly increasing: unlike
  // cursor movement, an action replayed from an old capture must never be
  // acted on.
  const sequences = new Map<string, number>();

  const key = (membershipId: string, scope: ControlScope) => `${membershipId}:${scope}`;
  const scopeShared = (scope: ControlScope) => options.allowsScope?.(scope) ?? false;

  const refuse = (reason: RefusalReason): InputDecision => ({ allowed: false, reason });

  function sharedDisplay(): string | undefined {
    return options.isPresenting() ? options.sharedDisplayId() : undefined;
  }

  return {
    stop(membershipId, scope) {
      const scopes: ControlScope[] = scope ? [scope] : ['pointer', 'keyboard'];
      let stopped = 0;
      for (const each of scopes) {
        stops.set(key(membershipId, each), { membershipId, scope: each, stoppedAtMs: now() });
        stopped += 1;
      }
      return stopped;
    },

    resume(membershipId, scope) {
      const scopes: ControlScope[] = scope ? [scope] : ['pointer', 'keyboard'];
      for (const each of scopes) stops.delete(key(membershipId, each));
    },

    stopped: () => [...stops.values()],

    clearStops: () => stops.clear(),

    allows(membershipId, scope) {
      if (membershipId === options.localMembershipId) return false;
      // A guest is never part of "the room" for control purposes, whatever
      // the room-wide switch says.
      if (options.isGuestMembership?.(membershipId)) return false;
      if (!sharedDisplay()) return false;
      if (!scopeShared(scope)) return false;
      return !stops.has(key(membershipId, scope));
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
        // Only the presenter decides how their machine is shared. If we are
        // presenting, that is us, and a peer claiming otherwise is refused.
        if (options.isPresenting()) return refuse('not-presenter');
        const presenter = options.presenterMembershipId?.();
        if (!presenter || presenter !== message.membershipId) return refuse('not-presenter');
        sequences.set(message.membershipId, message.seq);
        return { allowed: true, message };
      }

      // Everything below acts on this machine.
      if (!options.isPresenting()) return refuse('not-presenting');

      // A guest is refused before anything else here: not a stop, not a
      // scope check, and not something a room-wide "shared" switch can ever
      // undo. Checked here rather than folded into a scope check because a
      // guest must be refused even if a future scope needs no room-wide
      // switch at all.
      if (options.isGuestMembership?.(message.membershipId)) return refuse('guest');

      const scope = isLeaseMessage(message) ? message.scope : scopeOf(message);
      if (!scope) return refuse('malformed');

      if (!scopeShared(scope)) return refuse('scope-off');
      if (stops.has(key(message.membershipId, scope))) return refuse('stopped');

      const display = sharedDisplay();
      if (!display) return refuse('wrong-display');
      // A pointer action names the display it is aimed at; aiming at one that is
      // not being shared is not something to interpret generously.
      if (isPointerMessage(message) && message.displayId !== display) {
        return refuse('wrong-display');
      }

      sequences.set(message.membershipId, message.seq);
      return { allowed: true, message };
    },

    forget(membershipId) {
      sequences.delete(membershipId);
      for (const scope of ['pointer', 'keyboard'] as const) {
        stops.delete(key(membershipId, scope));
      }
    },
  };
}
