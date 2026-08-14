/**
 * Remote cursor receiver: sequence gating plus interpolation.
 *
 * Cursors are synthetic overlays. Rendering them is deliberately decoupled from
 * video: the screen may be arriving at 8fps while cursors stay smooth, because
 * a laggy pointer is what makes a shared screen feel dead (SPEC.md §8.1).
 *
 * Interpolation smooths between packets but must never *trail* the truth: it
 * converges on the newest position within one interval, so a fast flick lands
 * where the sender is, not where they were.
 */
import { createSequenceGate, type CursorMove } from '@layup/protocol';

export interface RemoteCursor {
  membershipId: string;
  displayId: string;
  /** Normalised position to draw right now (interpolated). */
  x: number;
  y: number;
  /** The latest position actually received. */
  targetX: number;
  targetY: number;
  updatedAtMs: number;
}

export interface CursorReceiverOptions {
  /**
   * How long a cursor takes to converge on a new packet, in milliseconds.
   * Roughly one send interval: long enough to smooth, short enough not to lag.
   */
  smoothingMs?: number;
  /** A cursor with no update for this long is dropped as gone. */
  staleAfterMs?: number;
  now?: () => number;
}

export interface CursorReceiver {
  /** Applies an incoming move. Returns false when it was stale and ignored. */
  apply(move: CursorMove): boolean;
  /** Advances interpolation to `now` and returns what to draw. */
  sample(): RemoteCursor[];
  /** Removes a cursor, e.g. when its membership leaves. */
  remove(membershipId: string): void;
  clear(): void;
}

export function createCursorReceiver(options: CursorReceiverOptions = {}): CursorReceiver {
  const smoothingMs = options.smoothingMs ?? 16;
  const staleAfterMs = options.staleAfterMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const gate = createSequenceGate();
  const cursors = new Map<string, RemoteCursor>();

  return {
    apply(move) {
      // Late arrivals on the unordered channel would drag the cursor backwards.
      if (!gate.accept(move.membershipId, move.seq)) return false;

      const existing = cursors.get(move.membershipId);
      cursors.set(move.membershipId, {
        membershipId: move.membershipId,
        displayId: move.displayId,
        // A cursor that has never been seen appears where it is, not at the
        // origin; an existing one glides from where it is being drawn.
        x: existing?.x ?? move.x,
        y: existing?.y ?? move.y,
        targetX: move.x,
        targetY: move.y,
        updatedAtMs: now(),
      });
      return true;
    },

    sample() {
      const currentTime = now();
      const out: RemoteCursor[] = [];

      for (const [membershipId, cursor] of [...cursors.entries()]) {
        if (currentTime - cursor.updatedAtMs > staleAfterMs) {
          cursors.delete(membershipId);
          gate.forget(membershipId);
          continue;
        }
        const elapsed = currentTime - cursor.updatedAtMs;
        // Converge within smoothingMs, then sit exactly on the target: the
        // interpolator never lags behind the latest packet indefinitely.
        const progress = smoothingMs <= 0 ? 1 : Math.min(1, elapsed / smoothingMs);
        cursor.x += (cursor.targetX - cursor.x) * progress;
        cursor.y += (cursor.targetY - cursor.y) * progress;
        out.push({ ...cursor });
      }
      return out;
    },

    remove(membershipId) {
      cursors.delete(membershipId);
      // A rejoining membership gets a new id, but forgetting the sequence keeps
      // a reused id from inheriting stale state.
      gate.forget(membershipId);
    },

    clear() {
      for (const membershipId of cursors.keys()) gate.forget(membershipId);
      cursors.clear();
    },
  };
}
