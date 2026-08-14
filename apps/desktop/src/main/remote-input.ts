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
  TYPE_KEY_DOWN,
  TYPE_KEY_UP,
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
  /**
   * How long the presenter's own input keeps remote control out after they
   * touch their mouse or keyboard. Long enough to finish a sentence or a drag;
   * short enough that control resumes without anybody asking for it back.
   */
  localPriorityMs?: number;
  now?: () => number;
}

export interface RemoteInputStats {
  injected: number;
  /** Actions the guard refused. */
  refused: number;
  /** Actions refused because somebody else was mid-drag. */
  busy: number;
  /** Actions refused because the presenter was using their own machine. */
  preempted: number;
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
  ): Promise<{
    injected: boolean;
    reason?: RefusalReason | 'no-helper' | 'unknown-display' | 'busy' | 'local-input';
  }>;
  /**
   * Ends any lease that has gone quiet, releasing whatever it was holding.
   * The caller drives this from its own scheduler.
   */
  expireLeases(): number;
  /** Waits for any release still in flight. */
  settle(): Promise<void>;
  /** Lets go of everything a membership holds - it left, or was revoked. */
  releaseFor(membershipId: string, cause?: LeaseEndCause): Promise<void>;
  /** Who is mid-drag, if anybody. */
  dragging(): string | undefined;
  /** Who holds the keyboard, if anybody. */
  typing(): string | undefined;
  /**
   * The presenter just used their own mouse or keyboard.
   *
   * The rule (SPEC.md §13.3): local input wins, immediately and without asking.
   * Every remote lease ends, everything held is released, and remote actions
   * are refused for a short window afterwards - long enough that the
   * presenter's own drag or sentence is not fought over halfway through.
   */
  localInput(): void;
  /** Whether local input currently has priority. */
  localHasPriority(): boolean;
  /**
   * The helper went away and came back. Whatever it was holding died with the
   * old process, so this side must forget it rather than trying to release
   * buttons the new process never pressed.
   */
  helperRestarted(): void;
  /** Where this router last put the OS pointer, for local-input detection. */
  lastInjectedPoint(): { x: number; y: number } | undefined;
  stats(): RemoteInputStats;
}

export function createRemoteInputRouter(options: RemoteInputOptions): RemoteInputRouter {
  const stats: RemoteInputStats = {
    injected: 0,
    refused: 0,
    busy: 0,
    preempted: 0,
    unmapped: 0,
    unavailable: 0,
  };
  const localPriorityMs = options.localPriorityMs ?? 1_500;
  const now = options.now ?? (() => Date.now());
  let localUntilMs = Number.NEGATIVE_INFINITY;
  let lastPoint: { x: number; y: number } | undefined;
  // What each membership is holding down here, so a lease that ends for any
  // reason can let go of it. A stuck button or modifier on somebody else's
  // machine is the worst outcome this module has (SPEC.md §13.3).
  const heldButtons = new Map<string, Set<string>>();
  // Keys are held in press order, so they can be released in reverse: a
  // modifier pressed first comes up last, and no intermediate release lands as
  // a bare keystroke. Codes only - never what was typed (SPEC.md §13.4).
  const heldKeys = new Map<string, string[]>();

  const leases = options.leases ?? createInputLeases();
  // Releasing is asynchronous - it talks to the helper - but a lease ends
  // synchronously. The work is chained so callers can wait for it to finish
  // rather than hoping it has; nothing else guarantees a button is up before
  // the next person takes the lease.
  let releasing: Promise<unknown> = Promise.resolve();
  // Registered rather than passed in at construction, so a lease supplied by
  // the caller still releases what it was holding.
  leases.onEnd((lease, cause) => {
    releasing = releasing.then(() => releaseHeld(lease, cause));
  });

  async function releaseHeld(lease: Lease, cause: LeaseEndCause) {
    const buttons = lease.scope === 'pointer' ? [...(heldButtons.get(lease.membershipId) ?? [])] : [];
    const keys = lease.scope === 'keyboard' ? [...(heldKeys.get(lease.membershipId) ?? [])] : [];
    if (buttons.length === 0 && keys.length === 0) return;

    if (lease.scope === 'pointer') heldButtons.delete(lease.membershipId);
    else heldKeys.delete(lease.membershipId);

    const helper = options.helper();
    if (!helper) return;

    // Reverse press order: the modifier that was held over another key is the
    // last thing to come up.
    for (const code of keys.reverse()) {
      await sendQuietly(helper, 'key', { code, down: false }, cause);
    }
    for (const button of buttons) {
      await sendQuietly(helper, 'pointer.button', { button, down: false }, cause);
    }

    options.log.info('released input held by a finished lease', {
      membershipId: lease.membershipId,
      scope: lease.scope,
      cause,
      buttons: buttons.length,
      keys: keys.length,
    });
  }

  async function sendQuietly(
    helper: HelperClient,
    command: 'key' | 'pointer.button',
    payload: Record<string, unknown>,
    cause: LeaseEndCause,
  ) {
    try {
      await helper.send(command, payload);
    } catch (error) {
      // Never log the payload: it may be a key code (SPEC.md §13.4).
      options.log.warn('could not release held input', {
        command,
        cause,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Moves the pointer and remembers where, so local movement is detectable. */
  async function moveTo(helper: HelperClient, point: { x: number; y: number }) {
    await helper.send('pointer.move', point);
    lastPoint = point;
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
        await moveTo(helper, point);
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

      case TYPE_KEY_DOWN:
      case TYPE_KEY_UP: {
        await helper.send('key', { code: message.code, down: message.type === TYPE_KEY_DOWN });
        return true;
      }

      case TYPE_POINTER_WHEEL: {
        const point = toScreenPoint(message, options.displays());
        if (!point) return false;
        // The wheel applies to whatever is under the pointer, so it is aimed
        // the same way a click is.
        await moveTo(helper, point);
        await helper.send('pointer.wheel', { deltaX: message.deltaX, deltaY: message.deltaY });
        return true;
      }

      default:
        // Control and lease messages are decisions, not injections. Nothing
        // else reaches the OS from here.
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

      // The presenter's own hands win. Nothing remote acts while they are
      // using their machine, whatever grants or leases say.
      if (now() < localUntilMs && isDestructive(message.type)) {
        stats.preempted += 1;
        return { injected: false, reason: 'local-input' };
      }

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
      } else if (message.type === TYPE_KEY_DOWN) {
        // Typing takes the keyboard, and every keystroke renews it. Two people
        // typing into one editor is not collaboration, it is a mess.
        if (!leases.acquire('keyboard', from.membershipId)) {
          stats.busy += 1;
          return { injected: false, reason: 'busy' };
        }
      } else if (message.type === TYPE_KEY_UP) {
        // A key-up is never refused for a key this membership is holding: the
        // alternative is a modifier stuck down on the presenter's machine.
        if (!holdsKey(from.membershipId, message.code) && !leases.mayAct('keyboard', from.membershipId)) {
          stats.busy += 1;
          return { injected: false, reason: 'busy' };
        }
        leases.touch('keyboard', from.membershipId);
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

    settle: async () => void (await releasing),

    localInput() {
      localUntilMs = now() + localPriorityMs;
      // End every remote lease, releasing whatever it holds. The presenter
      // should never have to wrestle their own pointer back.
      for (const membershipId of leaseHolders()) {
        leases.releaseAll(membershipId, 'local-input');
      }
    },

    localHasPriority: () => now() < localUntilMs,

    helperRestarted() {
      // Nothing survived the old process, so releasing would post presses the
      // new one never saw. Forget instead, and end the leases so the next
      // action starts cleanly.
      heldButtons.clear();
      heldKeys.clear();
      for (const membershipId of leaseHolders()) {
        leases.releaseAll(membershipId, 'disconnect');
      }
      lastPoint = undefined;
      options.log.info('remote input state cleared after helper restart');
    },

    lastInjectedPoint: () => lastPoint,

    async releaseFor(membershipId, cause = 'disconnect') {
      // Ending the leases is what lets go of the input. Anything held without a
      // lease - a press that arrived before one was taken - is released too.
      const ended = leases.releaseAll(membershipId, cause);
      if (ended === 0) {
        for (const scope of ['pointer', 'keyboard'] as const) {
          await releaseHeld({ scope, membershipId, acquiredAtMs: 0, touchedAtMs: 0 }, cause);
        }
      }
      await releasing;
    },

    dragging: () => leases.holder('pointer')?.membershipId,

    typing: () => leases.holder('keyboard')?.membershipId,

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
      return;
    }
    if (message.type === TYPE_KEY_DOWN) {
      const held = heldKeys.get(membershipId) ?? [];
      if (!held.includes(message.code)) held.push(message.code);
      heldKeys.set(membershipId, held);
      return;
    }
    if (message.type === TYPE_KEY_UP) {
      const held = (heldKeys.get(membershipId) ?? []).filter((code) => code !== message.code);
      heldKeys.set(membershipId, held);
      // Unlike a drag, the keyboard lease is not handed back on key-up: typing
      // is a run of presses with gaps, and losing the keyboard between two
      // keystrokes would let somebody else type into the middle of a word. It
      // ends on inactivity, disconnect or revoke instead.
    }
  }

  function holdsKey(membershipId: string, code: string): boolean {
    return (heldKeys.get(membershipId) ?? []).includes(code);
  }

  /** Everybody currently holding a lease, in no particular order. */
  function leaseHolders(): string[] {
    const holders = new Set<string>();
    for (const scope of ['pointer', 'keyboard'] as const) {
      const holder = leases.holder(scope);
      if (holder) holders.add(holder.membershipId);
    }
    return [...holders];
  }
}

function isDestructive(type: string): boolean {
  return isPointerAction(type) || type === TYPE_POINTER_DOWN || type === TYPE_KEY_DOWN || type === TYPE_KEY_UP;
}

function isPointerAction(type: string): boolean {
  return type === TYPE_POINTER_UP || type === TYPE_POINTER_CLICK || type === TYPE_POINTER_WHEEL;
}
