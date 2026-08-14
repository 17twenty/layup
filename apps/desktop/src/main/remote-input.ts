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
}

export interface RemoteInputStats {
  injected: number;
  /** Actions the guard refused. */
  refused: number;
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
  ): Promise<{ injected: boolean; reason?: RefusalReason | 'no-helper' | 'unknown-display' }>;
  stats(): RemoteInputStats;
}

export function createRemoteInputRouter(options: RemoteInputOptions): RemoteInputRouter {
  const stats: RemoteInputStats = { injected: 0, refused: 0, unmapped: 0, unavailable: 0 };

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

      const helper = options.helper();
      if (!helper) {
        stats.unavailable += 1;
        return { injected: false, reason: 'no-helper' };
      }

      const injected = await inject(decision.message, helper);
      if (!injected) {
        // Either an unknown display or a message type that does not inject.
        stats.unmapped += 1;
        return { injected: false, reason: 'unknown-display' };
      }
      stats.injected += 1;
      return { injected: true };
    },

    stats: () => ({ ...stats }),
  };
}
