/**
 * Cursor sender: coalescing, bounded, latest-wins.
 *
 * A trackpad produces pointer events far faster than anyone needs to see them,
 * and on a congested link a queue of positions is worse than useless - every
 * entry except the last is already wrong by the time it arrives (ADR-0008).
 *
 * So this holds exactly one pending position per display and emits on a fixed
 * cadence. Memory is O(displays), not O(events), whatever the input rate.
 */
import { TYPE_CURSOR_MOVE, toCursorMove, type CursorMove } from '@layup/protocol';

export interface CursorSenderOptions {
  membershipId: string;
  /** Delivers one message. Returning false means the channel was not ready. */
  send: (move: CursorMove) => boolean;
  /** Minimum gap between sends. 60Hz where practical (SPEC.md §16). */
  intervalMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface CursorSenderStats {
  /** Pointer positions accepted from the local pointer. */
  observed: number;
  /** Messages actually sent. */
  sent: number;
  /** Positions superseded before they were ever sent. */
  coalesced: number;
  /** Sends refused by the channel. */
  refused: number;
  /** Pending positions held right now - one per display, at most. */
  pending: number;
}

export interface CursorSender {
  /** Records a local pointer position over a surface of the given size. */
  move(input: { displayId: string; x: number; y: number; width: number; height: number }): void;
  /** Sends anything pending immediately. */
  flush(): void;
  stats(): CursorSenderStats;
  stop(): void;
}

export function createCursorSender(options: CursorSenderOptions): CursorSender {
  const intervalMs = options.intervalMs ?? 16; // ~60Hz
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));

  // At most one pending position per display: a newer position for the same
  // display simply overwrites the older one.
  const pending = new Map<string, { x: number; y: number; width: number; height: number }>();
  const stats: CursorSenderStats = { observed: 0, sent: 0, coalesced: 0, refused: 0, pending: 0 };

  let seq = 0;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function emit() {
    timer = undefined;
    if (stopped || pending.size === 0) return;

    for (const [displayId, position] of [...pending.entries()]) {
      pending.delete(displayId);
      const move = toCursorMove({
        membershipId: options.membershipId,
        displayId,
        seq: (seq += 1),
        ...position,
      });
      if (options.send(move)) stats.sent += 1;
      else stats.refused += 1;
    }
    lastSentAt = now();
    stats.pending = pending.size;
  }

  function arm() {
    if (timer !== undefined || stopped) return;
    const elapsed = now() - lastSentAt;
    const wait = elapsed >= intervalMs ? 0 : intervalMs - elapsed;
    timer = schedule(emit, wait);
  }

  return {
    move(input) {
      if (stopped) return;
      stats.observed += 1;
      if (pending.has(input.displayId)) stats.coalesced += 1;
      pending.set(input.displayId, {
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
      });
      stats.pending = pending.size;
      arm();
    },

    flush() {
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      emit();
    },

    stats: () => ({ ...stats }),

    stop() {
      stopped = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      pending.clear();
      stats.pending = 0;
    },
  };
}

export { TYPE_CURSOR_MOVE };
