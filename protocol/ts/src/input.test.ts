import { describe, expect, it } from 'vitest';
import {
  INPUT_PROTOCOL_VERSION,
  MAX_WHEEL_DELTA,
  TYPE_CONTROL_GRANT,
  TYPE_CONTROL_REVOKE,
  TYPE_KEY_DOWN,
  TYPE_LEASE_ACQUIRE,
  TYPE_POINTER_CLICK,
  TYPE_POINTER_DOWN,
  TYPE_POINTER_WHEEL,
  decodeInput,
  isPlausibleKeyCode,
  scopeOf,
} from './input';

const base = { v: INPUT_PROTOCOL_VERSION, membershipId: 'm-1', seq: 1 };
const pointer = { ...base, displayId: 'd-1', x: 0.5, y: 0.5 };

describe('input protocol', () => {
  it('decodes every message the reliable channel carries', () => {
    const messages: unknown[] = [
      { ...pointer, type: TYPE_POINTER_DOWN, button: 'left' },
      { ...pointer, type: 'pointer.up', button: 'right' },
      { ...pointer, type: TYPE_POINTER_CLICK, button: 'middle', clickCount: 2 },
      { ...pointer, type: TYPE_POINTER_WHEEL, deltaX: 0, deltaY: -3 },
      { ...base, type: TYPE_KEY_DOWN, code: 'KeyA' },
      { ...base, type: 'key.up', code: 'ShiftLeft' },
      { ...base, type: TYPE_CONTROL_GRANT, targetMembershipId: 'm-2', scope: 'pointer', grantId: 'g-1' },
      { ...base, type: TYPE_CONTROL_REVOKE },
      { ...base, type: TYPE_LEASE_ACQUIRE, scope: 'keyboard' },
      { ...base, type: 'lease.release', scope: 'keyboard' },
    ];

    for (const message of messages) {
      expect(() => decodeInput(message)).not.toThrow();
    }
  });

  it('refuses a version it does not implement', () => {
    // Guessing at the meaning of an unfamiliar field would mean guessing at
    // what to do to somebody else's machine.
    expect(() => decodeInput({ ...pointer, v: 2, type: TYPE_POINTER_DOWN, button: 'left' })).toThrow(
      /version 2 is not supported/,
    );
  });

  it('refuses malformed and out-of-range messages', () => {
    const bad: Array<[string, unknown]> = [
      ['unknown type', { ...base, type: 'pointer.teleport' }],
      ['missing button', { ...pointer, type: TYPE_POINTER_DOWN }],
      ['unknown button', { ...pointer, type: TYPE_POINTER_DOWN, button: 'extra' }],
      ['coordinate outside the surface', { ...pointer, type: TYPE_POINTER_DOWN, x: 1.5, button: 'left' }],
      [
        'runaway wheel',
        { ...pointer, type: TYPE_POINTER_WHEEL, deltaX: 0, deltaY: MAX_WHEEL_DELTA + 1 },
      ],
      ['fractional wheel', { ...pointer, type: TYPE_POINTER_WHEEL, deltaX: 0, deltaY: 0.5 }],
      ['negative sequence', { ...pointer, type: TYPE_POINTER_DOWN, button: 'left', seq: -1 }],
      ['too many clicks', { ...pointer, type: TYPE_POINTER_CLICK, button: 'left', clickCount: 9 }],
      ['unknown scope', { ...base, type: TYPE_LEASE_ACQUIRE, scope: 'clipboard' }],
    ];

    for (const [name, message] of bad) {
      expect(() => decodeInput(message), name).toThrow();
    }
  });

  it('will not carry typed content dressed up as a key code', () => {
    // A key code names a physical key. Anything that looks like a sentence,
    // a password or a paste is not one (SPEC.md §13.4).
    expect(isPlausibleKeyCode('KeyA')).toBe(true);
    expect(isPlausibleKeyCode('Digit1')).toBe(true);
    expect(isPlausibleKeyCode('')).toBe(false);
    expect(isPlausibleKeyCode('hunter2 is my password')).toBe(false);
    expect(isPlausibleKeyCode('a'.repeat(64))).toBe(false);

    expect(() => decodeInput({ ...base, type: TYPE_KEY_DOWN, code: 'my bank password' })).toThrow(
      /KeyboardEvent.code/,
    );
  });

  it('says which grant each action needs', () => {
    expect(scopeOf(decodeInput({ ...pointer, type: TYPE_POINTER_DOWN, button: 'left' }))).toBe('pointer');
    expect(scopeOf(decodeInput({ ...base, type: TYPE_KEY_DOWN, code: 'KeyA' }))).toBe('keyboard');
    // A grant is not itself an action, so it needs no scope of its own.
    expect(scopeOf(decodeInput({ ...base, type: TYPE_CONTROL_REVOKE }))).toBeUndefined();
  });
});
