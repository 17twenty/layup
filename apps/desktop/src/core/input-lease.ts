/**
 * Short exclusive leases over the presenter's pointer and keyboard
 * (SPEC.md §11 `lease.acquire`, §13.3).
 *
 * A drag is not one action - it is a press, a run of moves, and a release, and
 * it only means anything if all three come from the same person. Two people
 * dragging at once do not produce two drags; they produce one object thrown
 * across the screen. So a mouse-down takes an exclusive lease, and while it is
 * held every other participant's destructive pointer action is refused.
 *
 * Three things end a lease, and the last two matter most:
 *
 *   - the mouse-up that finishes the drag;
 *   - a disconnect, because a peer that vanished mid-drag would otherwise hold
 *     the pointer forever;
 *   - a timeout, because a peer that stops sending without disconnecting looks
 *     exactly the same from here.
 *
 * The clock is injected. A lease that expires only when somebody happens to
 * call in is not a lease, so `expire()` is driven by the caller's scheduler and
 * tested with a fake clock rather than by waiting.
 */
import type { ControlScope } from '@layup/protocol';

export interface Lease {
  scope: ControlScope;
  membershipId: string;
  acquiredAtMs: number;
  /** Last time this membership did something with the lease. */
  touchedAtMs: number;
}

export interface InputLeasesOptions {
  /**
   * How long a lease survives with no activity. Short: long enough to cover a
   * slow drag across a big screen, far too short to strand the pointer.
   */
  idleTimeoutMs?: number;
  now?: () => number;
  /** Told when a lease ends, so held buttons and keys can be released. */
  onReleased?: LeaseEndListener;
}

export type LeaseEndCause = 'released' | 'timeout' | 'disconnect' | 'revoked' | 'local-input';

export type LeaseEndListener = (lease: Lease, cause: LeaseEndCause) => void;

export interface InputLeases {
  /**
   * Subscribes to lease endings. Everything that holds input must hear about
   * every ending, however the lease was created - a listener attached only at
   * construction is a stuck button waiting to happen.
   */
  onEnd(listener: LeaseEndListener): () => void;
  /**
   * Takes the lease for a membership, or renews its own. Returns false when
   * somebody else holds it.
   */
  acquire(scope: ControlScope, membershipId: string): boolean;
  /** Whether this membership may act in this scope right now. */
  mayAct(scope: ControlScope, membershipId: string): boolean;
  /** Records activity, keeping a live lease from timing out mid-drag. */
  touch(scope: ControlScope, membershipId: string): void;
  /** Ends a lease held by this membership. */
  release(scope: ControlScope, membershipId: string, cause?: LeaseEndCause): boolean;
  /** Ends every lease this membership holds - a disconnect or a revoke. */
  releaseAll(membershipId: string, cause?: LeaseEndCause): number;
  /** Ends leases that have gone quiet. Returns how many were dropped. */
  expire(): number;
  holder(scope: ControlScope): Lease | undefined;
}

export function createInputLeases(options: InputLeasesOptions = {}): InputLeases {
  const idleTimeoutMs = options.idleTimeoutMs ?? 2_000;
  const now = options.now ?? (() => Date.now());
  const leases = new Map<ControlScope, Lease>();
  const listeners = new Set<LeaseEndListener>();
  if (options.onReleased) listeners.add(options.onReleased);

  function end(scope: ControlScope, cause: LeaseEndCause): boolean {
    const lease = leases.get(scope);
    if (!lease) return false;
    leases.delete(scope);
    // The listeners release whatever was held. A lease that ends without that
    // is how a button gets stuck down on somebody else's machine.
    for (const listener of listeners) listener(lease, cause);
    return true;
  }

  return {
    onEnd(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    acquire(scope, membershipId) {
      const current = leases.get(scope);
      if (current && current.membershipId !== membershipId) {
        // Do not steal it. A drag in progress belongs to whoever started it,
        // until it ends or times out.
        if (now() - current.touchedAtMs < idleTimeoutMs) return false;
        end(scope, 'timeout');
      }

      const moment = now();
      const existing = leases.get(scope);
      leases.set(scope, {
        scope,
        membershipId,
        acquiredAtMs: existing?.acquiredAtMs ?? moment,
        touchedAtMs: moment,
      });
      return true;
    },

    mayAct(scope, membershipId) {
      const lease = leases.get(scope);
      if (!lease) return true; // Nobody is dragging; ordinary actions are fine.
      if (lease.membershipId === membershipId) return true;
      // Somebody else's lease, but a stale one: it should not block forever.
      return now() - lease.touchedAtMs >= idleTimeoutMs;
    },

    touch(scope, membershipId) {
      const lease = leases.get(scope);
      if (!lease || lease.membershipId !== membershipId) return;
      lease.touchedAtMs = now();
    },

    release(scope, membershipId, cause = 'released') {
      const lease = leases.get(scope);
      if (!lease || lease.membershipId !== membershipId) return false;
      return end(scope, cause);
    },

    releaseAll(membershipId, cause = 'disconnect') {
      let ended = 0;
      // Keyboard first, deliberately: whoever is listening releases keys before
      // buttons, so a modifier held over a drag comes up before the drag ends
      // rather than after it.
      for (const scope of ['keyboard', 'pointer'] as const) {
        const lease = leases.get(scope);
        if (!lease || lease.membershipId !== membershipId) continue;
        if (end(scope, cause)) ended += 1;
      }
      return ended;
    },

    expire() {
      const moment = now();
      let ended = 0;
      for (const [scope, lease] of [...leases.entries()]) {
        if (moment - lease.touchedAtMs < idleTimeoutMs) continue;
        if (end(scope, 'timeout')) ended += 1;
      }
      return ended;
    },

    holder: (scope) => leases.get(scope),
  };
}
