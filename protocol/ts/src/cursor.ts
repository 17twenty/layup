/**
 * Cursor protocol (SPEC.md §8.1, ADR-0008).
 *
 * Cursor motion is normalised, sequenced and loss-tolerant:
 *
 *   - coordinates are 0..1 of the *shared surface*, never receiver pixels, so a
 *     4K presenter and a laptop viewer agree about where the pointer is;
 *   - a display id keeps multi-display senders unambiguous;
 *   - a sequence number lets a receiver drop a stale update that overtook a
 *     newer one on an unordered channel - latest wins, always.
 *
 * A cursor never moves the host's OS pointer: these are synthetic overlays.
 */
import { isBoolean, isEnum, isInteger, isNormalised, isObject, isString, optional } from './validate';

export const TYPE_CURSOR_MOVE = 'cursor.move';
export const TYPE_CURSOR_PRESENCE = 'cursor.presence';
export const TYPE_CURSOR_HOVER = 'cursor.hover';

export const cursorMove = isObject({
  type: isEnum([TYPE_CURSOR_MOVE] as const),
  /** Which membership the cursor belongs to. */
  membershipId: isString,
  /** Which display of the shared surface, for a multi-display presenter. */
  displayId: isString,
  x: isNormalised,
  y: isNormalised,
  /** Monotonic per sender; wraps are handled by the receiver, not the sender. */
  seq: isInteger({ min: 0 }),
});
export type CursorMove = ReturnType<typeof cursorMove>;

export const cursorPresence = isObject({
  type: isEnum([TYPE_CURSOR_PRESENCE] as const),
  membershipId: isString,
  /** False when the cursor has left the shared surface entirely. */
  present: isBoolean,
  displayId: optional(isString),
  seq: isInteger({ min: 0 }),
});
export type CursorPresence = ReturnType<typeof cursorPresence>;

/** Clamps a coordinate into the normalised range instead of rejecting it. */
export function clampNormalised(value: number): number {
  // NaN has no direction to clamp towards, so it becomes the origin; an
  // infinity does have one and clamps to that edge.
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Builds a move message from a pointer position over an element of known size.
 *
 * Positions slightly outside the surface are clamped rather than dropped: a
 * pointer one pixel past the edge is a real position a person means, whereas a
 * NaN or a wildly out-of-range value is a bug and becomes 0.
 */
export function toCursorMove(input: {
  membershipId: string;
  displayId: string;
  seq: number;
  x: number;
  y: number;
  width: number;
  height: number;
}): CursorMove {
  const width = input.width > 0 ? input.width : 1;
  const height = input.height > 0 ? input.height : 1;
  return {
    type: TYPE_CURSOR_MOVE,
    membershipId: input.membershipId,
    displayId: input.displayId,
    x: clampNormalised(input.x / width),
    y: clampNormalised(input.y / height),
    seq: input.seq,
  };
}

/** Maps a normalised position back onto a receiver's pixels. */
export function toPixels(move: { x: number; y: number }, size: { width: number; height: number }) {
  return { x: move.x * size.width, y: move.y * size.height };
}

/**
 * Tracks the newest sequence seen per sender so stale updates can be dropped.
 *
 * On an unordered channel an older packet can arrive after a newer one; showing
 * it would make the cursor jump backwards, which reads as lag.
 */
export interface SequenceGate {
  /** True when this update is newer than everything seen from that sender. */
  accept(membershipId: string, seq: number): boolean;
  forget(membershipId: string): void;
}

export function createSequenceGate(options: { wrapWindow?: number } = {}): SequenceGate {
  // A sender that restarts (or wraps) jumps backwards by a lot; anything more
  // than this far behind is treated as a restart rather than a stale packet.
  const wrapWindow = options.wrapWindow ?? 1_000_000;
  const latest = new Map<string, number>();

  return {
    accept(membershipId, seq) {
      const previous = latest.get(membershipId);
      if (previous !== undefined && seq <= previous && previous - seq < wrapWindow) return false;
      latest.set(membershipId, seq);
      return true;
    },
    forget: (membershipId) => void latest.delete(membershipId),
  };
}
