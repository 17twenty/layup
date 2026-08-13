/**
 * Dependency-free structural validation used at every trust boundary:
 * renderer -> preload -> main, and later the WebRTC data plane.
 *
 * Validators throw `ValidationError` and never coerce. Anything crossing a
 * boundary is validated before it is acted on (ARCHITECTURE.md §11).
 */

export class ValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path || 'value'}: ${message}`);
    this.name = 'ValidationError';
    this.path = path;
  }
}

export type Validator<T> = (value: unknown, path?: string) => T;

function fail(path: string, message: string): never {
  throw new ValidationError(path, message);
}

export const isString: Validator<string> = (value, path = '') =>
  typeof value === 'string' ? value : fail(path, `expected string, got ${typeName(value)}`);

export const isBoolean: Validator<boolean> = (value, path = '') =>
  typeof value === 'boolean' ? value : fail(path, `expected boolean, got ${typeName(value)}`);

export const isFiniteNumber: Validator<number> = (value, path = '') =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(path, `expected finite number, got ${typeName(value)}`);

export function isInteger(options: { min?: number; max?: number } = {}): Validator<number> {
  return (value, path = '') => {
    const n = isFiniteNumber(value, path);
    if (!Number.isInteger(n)) fail(path, 'expected integer');
    if (options.min !== undefined && n < options.min) fail(path, `expected >= ${options.min}`);
    if (options.max !== undefined && n > options.max) fail(path, `expected <= ${options.max}`);
    return n;
  };
}

/** A coordinate in the 0..1 normalised space used by cursors and drawing. */
export const isNormalised: Validator<number> = (value, path = '') => {
  const n = isFiniteNumber(value, path);
  return n >= 0 && n <= 1 ? n : fail(path, 'expected a normalised value in [0,1]');
};

export function isStringOfLength(min: number, max: number): Validator<string> {
  return (value, path = '') => {
    const s = isString(value, path);
    if (s.length < min) fail(path, `expected at least ${min} characters`);
    if (s.length > max) fail(path, `expected at most ${max} characters`);
    return s;
  };
}

export function isLiteral<T extends string | number | boolean>(expected: T): Validator<T> {
  return (value, path = '') =>
    value === expected ? (value as T) : fail(path, `expected ${JSON.stringify(expected)}`);
}

export function isEnum<T extends string>(values: readonly T[]): Validator<T> {
  return (value, path = '') => {
    const s = isString(value, path);
    return values.includes(s as T) ? (s as T) : fail(path, `expected one of ${values.join('|')}`);
  };
}

export function isArrayOf<T>(item: Validator<T>, options: { max?: number } = {}): Validator<T[]> {
  return (value, path = '') => {
    if (!Array.isArray(value)) fail(path, `expected array, got ${typeName(value)}`);
    if (options.max !== undefined && value.length > options.max) {
      fail(path, `expected at most ${options.max} items`);
    }
    return value.map((entry, index) => item(entry, `${path}[${index}]`));
  };
}

export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (value, path = '') => (value === undefined || value === null ? undefined : inner(value, path));
}

export type Shape = Record<string, Validator<unknown>>;
export type Infer<S extends Shape> = { [K in keyof S]: S[K] extends Validator<infer T> ? T : never };

/**
 * Validates a plain object. Unknown keys are rejected rather than ignored so a
 * hostile renderer cannot smuggle fields past a permissive handler.
 */
export function isObject<S extends Shape>(shape: S): Validator<Infer<S>> {
  return (value, path = '') => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail(path, `expected object, got ${typeName(value)}`);
    }
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (!(key in shape)) fail(path ? `${path}.${key}` : key, 'unexpected property');
    }
    const result: Record<string, unknown> = {};
    for (const [key, validator] of Object.entries(shape)) {
      const child = validator(source[key], path ? `${path}.${key}` : key);
      if (child !== undefined) result[key] = child;
    }
    return result as Infer<S>;
  };
}

/** No payload at all. Used by channels that take no arguments. */
export const isVoid: Validator<undefined> = (value, path = '') =>
  value === undefined || value === null ? undefined : fail(path, 'expected no payload');

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
