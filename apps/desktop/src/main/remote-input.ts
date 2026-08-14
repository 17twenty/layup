/**
 * Where a permitted remote action becomes an OS event (SPEC.md §13.2, §13.3).
 *
 * This lives in the main process because the helper client does, and the
 * renderer must never hold a handle to it. What the renderer may do is *offer*
 * a message it received from a peer; every decision about whether that message
 * becomes a click is made here, by the guard, from state the presenter owns.
 *
 * Two rules are worth stating plainly, because they are what make remote
 * control safe rather than merely working:
 *
 *   - a **synthetic cursor never moves the OS pointer**. Cursor movement is an
 *     overlay and arrives on a different channel entirely; nothing on that path
 *     reaches this module (SPEC.md §8.1);
 *   - the OS pointer is only moved as part of an action that was allowed. A
 *     revoked participant's messages are dropped before any mapping happens, so
 *     a stale click cannot land somewhere by accident.
 */
import {
  TYPE_POINTER_CLICK,
  TYPE_POINTER_DOWN,
  TYPE_POINTER_UP,
  TYPE_POINTER_WHEEL,
  type InputMessage,
} from '@layup/protocol';
import { toScreenPoint, type DisplayBounds } from '../core/pointer-mapping';
import { createInputLeases, type InputLeases, type Lease, type LeaseEndCause } from '../core/input-lease';
import type { InputGuard, RefusalReason } from '../core/input-guard';
import type { HelperClient } from './helper-client';
import type { Logger } from './logging';

export interface RemoteInputOptions {
  guard: InputGuard;
  /** The helper, when one is running. Absent means remote control cannot act. */
  helper: () => HelperClient | undefined;
  /** The presenter's displays, in the OS's coordinate space. */
  displays: () => DisplayBounds[];
  log: Logger;
  /**
   * Exclusive short leases, so two people cannot drag the same thing at once.
   * Injectable so the timeout can be tested with a fake clock.
   */
  leases?: InputLeases;
}

export interface RemoteInputStats {
  injected: number;
  /** Actions the guard refused. */
  refused: number;
  /** Actions refused because somebody else was mid-drag. */
  busy: number;
  /** Actions that could not be aimed at a known display. */
  unmapped: number;
  /** Actions with nowhere to go because the helper is not running. */
  unavailable: number;
}

export interface RemoteInputRouter {
  /**
   * Offers one message received from a peer. Returns what happened - never
   * what was in the message.
   */
  handle(
    raw: unknown,
    from: { membershipId: string; channel: string },
  ): Promise<{ injected: boolean; reason?: RefusalReason | 'no-helper' | 'unknown-display' | 'busy' }>;
  /**
   * Ends any lease that has gone quiet, releasing whatever it was holding.
   * The caller drives this from its own scheduler.
   */
  expireLeases(): number;
  /** Lets go of everything a membership holds - it left, or was revoked. */
  releaseFor(membershipId: string, cause?: LeaseEndCause): Promise<void>;
  /** Who is mid-drag, if anybody. */
  dragging(): string | undefined;
  stats(): RemoteInputStats;
}

export function createRemoteInputRouter(options: RemoteInputOptions): RemoteInputRouter {
  const stats: RemoteInputStats = { injected: 0, refused: 0, busy: 0, unmapped: 0, unavailable: 0 };
  // What each membership is holding down here, so a lease that ends for any
  // reason can let go of it. A stuck button on somebody else's machine is the
  // worst outcome this module has (SPEC.md §13.3).
  const heldButtons = new Map<string, Set<string>>();

  const leases = options.leases ?? createInputLeases();
  // Registered rather than passed in at construction, so a lease supplied by
  // the caller still releases what it was holding.
  leases.onEnd((lease, cause) => void releaseHeld(lease, cause));

  async function releaseHeld(lease: Lease, cause: LeaseEndCause) {
    const held = heldButtons.get(lease.membershipId);
    if (!held || held.size === 0) return;
    heldButtons.delete(lease.membershipId);

    const helper = options.helper();
    if (!helper) return;
    for (const button of held) {
      try {
        await helper.send('pointer.button', { button, down: false });
      } catch (error) {
        options.log.warn('could not release a held button', {
          cause,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    options.log.info('released input held by a finished lease', {
      membershipId: lease.membershipId,
      scope: lease.scope,
      cause,
      buttons: held.size,
    });
  }

  async function inject(message: InputMessage, helper: HelperClient): Promise<boolean> {
    switch (message.type) {
      case TYPE_POINTER_DOWN:
      case TYPE_POINTER_UP:
      case TYPE_POINTER_CLICK: {
        const point = toScreenPoint(message, options.displays());
        if (!point) return false;
        // Position first, then press: a button posted at the old position
        // clicks whatever used to be under the pointer.
        await helper.send('pointer.move', { x: point.x, y: point.y });
        if (message.type === TYPE_POINTER_CLICK) {
          const clicks = message.clickCount ?? 1;
          // A double-click is two presses at one place, not one event with a
          // number attached: that is what applications actually listen for.
          for (let index = 0; index < clicks; index += 1) {
            await helper.send('pointer.button', { button: message.button, down: true });
            await helper.send('pointer.button', { button: message.button, down: false });
          }
          return true;
        }
        await helper.send('pointer.button', {
          button: message.button,
          down: message.type === TYPE_POINTER_DOWN,
        });
        return true;
      }

      case TYPE_POINTER_WHEEL: {
        const point = toScreenPoint(message, options.displays());
        if (!point) return false;
        // The wheel applies to whatever is under the pointer, so it is aimed
        // the same way a click is.
        await helper.send('pointer.move', { x: point.x, y: point.y });
        await helper.send('pointer.wheel', { deltaX: message.deltaX, deltaY: message.deltaY });
        return true;
      }

      default:
        // Keys are P1-0511's path; control and lease messages are decisions,
        // not injections. Nothing else reaches the OS from here.
        return false;
    }
  }

  return {
    async handle(raw, from) {
      const decision = options.guard.accept(raw, from);
      if (!decision.allowed) {
        stats.refused += 1;
        // The reason is a fixed word. The message itself is never logged: it
        // may be a keystroke (SPEC.md §13.4).
        options.log.debug('remote input refused', {
          membershipId: from.membershipId,
          reason: decision.reason,
        });
        return { injected: false, reason: decision.reason };
      }

      const message = decision.message;
      // A drag belongs to whoever started it. Anybody else's destructive
      // pointer action waits until the lease ends rather than fighting it.
      if (message.type === TYPE_POINTER_DOWN) {
        if (!leases.acquire('pointer', from.membershipId)) {
          stats.busy += 1;
          return { injected: false, reason: 'busy' };
        }
      } else if (isPointerAction(message.type)) {
        if (!leases.mayAct('pointer', from.membershipId)) {
          stats.busy += 1;
          return { injected: false, reason: 'busy' };
        }
        leases.touch('pointer', from.membershipId);
      }

      const helper = options.helper();
      if (!helper) {
        stats.unavailable += 1;
        return { injected: false, reason: 'no-helper' };
      }

      const injected = await inject(decision.message, helper);
      if (injected) trackHeld(message, from.membershipId);
      if (!injected) {
        // Either an unknown display or a message type that does not inject.
        stats.unmapped += 1;
        return { injected: false, reason: 'unknown-display' };
      }
      stats.injected += 1;
      return { injected: true };
    },

    expireLeases: () => leases.expire(),

    async releaseFor(membershipId, cause = 'disconnect') {
      // Release the lease first: its handler is what lets go of the buttons.
      if (leases.releaseAll(membershipId, cause) === 0) {
        await releaseHeld(
          { scope: 'pointer', membershipId, acquiredAtMs: 0, touchedAtMs: 0 },
          cause,
        );
      }
    },

    dragging: () => leases.holder('pointer')?.membershipId,

    stats: () => ({ ...stats }),
  };

  /** Remembers a press and forgets a release, so cleanup knows what is down. */
  function trackHeld(message: InputMessage, membershipId: string) {
    if (message.type === TYPE_POINTER_DOWN) {
      const held = heldButtons.get(membershipId) ?? new Set<string>();
      held.add(message.button);
      heldButtons.set(membershipId, held);
      return;
    }
    if (message.type === TYPE_POINTER_UP) {
      heldButtons.get(membershipId)?.delete(message.button);
      // The drag is over: the lease goes back immediately rather than waiting
      // for the idle timeout.
      leases.release('pointer', membershipId);
    }
  }
}

function isPointerAction(type: string): boolean {
  return type === TYPE_POINTER_UP || type === TYPE_POINTER_CLICK || type === TYPE_POINTER_WHEEL;
}
