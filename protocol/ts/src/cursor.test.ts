import { describe, expect, it } from 'vitest';
import {
  TYPE_CURSOR_MOVE,
  clampNormalised,
  createSequenceGate,
  cursorMove,
  toCursorMove,
  toPixels,
} from './cursor';
import { ValidationError } from './validate';

describe('cursor coordinates', () => {
  it('normalises to the shared surface, not receiver pixels', () => {
    const move = toCursorMove({
      membershipId: 'mem_a',
      displayId: 'display-1',
      seq: 1,
      x: 960,
      y: 300,
      width: 3840,
      height: 2400,
    });

    expect(move).toMatchObject({ type: TYPE_CURSOR_MOVE, x: 0.25, y: 0.125, displayId: 'display-1' });

    // The same position lands correctly on a differently sized receiver.
    expect(toPixels(move, { width: 1280, height: 800 })).toEqual({ x: 320, y: 100 });
  });

  it('clamps a position just off the edge rather than dropping it', () => {
    const move = toCursorMove({
      membershipId: 'mem_a',
      displayId: 'd',
      seq: 1,
      x: -3,
      y: 2401,
      width: 3840,
      height: 2400,
    });
    expect(move.x).toBe(0);
    expect(move.y).toBe(1);
  });

  it('turns nonsense into a safe value instead of NaN', () => {
    expect(clampNormalised(Number.NaN)).toBe(0);
    expect(clampNormalised(Number.POSITIVE_INFINITY)).toBe(1);
    expect(
      toCursorMove({ membershipId: 'm', displayId: 'd', seq: 0, x: 10, y: 10, width: 0, height: 0 }).x,
    ).toBe(1);
  });

  it('rejects a malformed message on the wire', () => {
    const valid = { type: TYPE_CURSOR_MOVE, membershipId: 'mem_a', displayId: 'd', x: 0.5, y: 0.5, seq: 3 };
    expect(cursorMove(valid)).toEqual(valid);

    // Out-of-range coordinates from a peer are rejected, not clamped: clamping
    // is for our own input, validation is for someone else's.
    expect(() => cursorMove({ ...valid, x: 1.5 })).toThrow(ValidationError);
    expect(() => cursorMove({ ...valid, y: -0.1 })).toThrow(ValidationError);
    expect(() => cursorMove({ ...valid, seq: -1 })).toThrow(ValidationError);
    expect(() => cursorMove({ ...valid, seq: 1.5 })).toThrow(ValidationError);
    expect(() => cursorMove({ ...valid, extra: true })).toThrow(ValidationError);
  });
});

describe('sequence gate', () => {
  it('accepts newer updates and drops ones that arrived late', () => {
    const gate = createSequenceGate();
    expect(gate.accept('mem_a', 1)).toBe(true);
    expect(gate.accept('mem_a', 2)).toBe(true);
    // An older packet overtaking a newer one on an unordered channel.
    expect(gate.accept('mem_a', 1)).toBe(false);
    expect(gate.accept('mem_a', 2)).toBe(false);
    expect(gate.accept('mem_a', 3)).toBe(true);
  });

  it('tracks each sender independently', () => {
    const gate = createSequenceGate();
    expect(gate.accept('mem_a', 10)).toBe(true);
    expect(gate.accept('mem_b', 1)).toBe(true);
    expect(gate.accept('mem_b', 2)).toBe(true);
    expect(gate.accept('mem_a', 9)).toBe(false);
  });

  it('recovers when a sender restarts its sequence', () => {
    const gate = createSequenceGate({ wrapWindow: 100 });
    expect(gate.accept('mem_a', 500)).toBe(true);
    // A big jump backwards is a restart, not a stale packet.
    expect(gate.accept('mem_a', 1)).toBe(true);
    expect(gate.accept('mem_a', 2)).toBe(true);
  });

  it('forgets a sender that has gone', () => {
    const gate = createSequenceGate();
    gate.accept('mem_a', 99);
    gate.forget('mem_a');
    expect(gate.accept('mem_a', 1)).toBe(true);
  });
});
