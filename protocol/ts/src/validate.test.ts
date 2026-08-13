import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  isArrayOf,
  isEnum,
  isInteger,
  isNormalised,
  isObject,
  isString,
  isVoid,
  optional,
} from './validate';

describe('validate', () => {
  it('accepts well-formed objects and strips nothing it was promised', () => {
    const shape = isObject({ id: isString, seq: isInteger({ min: 0 }), note: optional(isString) });
    expect(shape({ id: 'a', seq: 3 })).toEqual({ id: 'a', seq: 3 });
    expect(shape({ id: 'a', seq: 3, note: 'hi' })).toEqual({ id: 'a', seq: 3, note: 'hi' });
  });

  it('rejects unknown properties instead of ignoring them', () => {
    const shape = isObject({ id: isString });
    expect(() => shape({ id: 'a', isAdmin: true })).toThrow(ValidationError);
  });

  it('reports the failing path', () => {
    const shape = isObject({ inner: isObject({ seq: isInteger() }) });
    expect(() => shape({ inner: { seq: 'nope' } }, 'msg')).toThrow(/msg\.inner\.seq: expected finite number/);
  });

  it('rejects non-finite numbers, out-of-range integers and bad enums', () => {
    expect(() => isInteger({ min: 1 })(0)).toThrow(ValidationError);
    expect(() => isInteger()(1.5)).toThrow(ValidationError);
    expect(() => isNormalised(1.2)).toThrow(ValidationError);
    expect(() => isEnum(['a', 'b'] as const)('c')).toThrow(ValidationError);
    expect(isNormalised(0.5)).toBe(0.5);
  });

  it('bounds arrays so a hostile sender cannot allocate without limit', () => {
    const list = isArrayOf(isInteger(), { max: 2 });
    expect(list([1, 2])).toEqual([1, 2]);
    expect(() => list([1, 2, 3])).toThrow(ValidationError);
  });

  it('treats null and undefined as absent payloads', () => {
    expect(isVoid(undefined)).toBeUndefined();
    expect(isVoid(null)).toBeUndefined();
    expect(() => isVoid('payload')).toThrow(ValidationError);
  });
});
