/**
 * Structured logging for the Electron main process.
 *
 * One JSON object per line, correlation fields attached by `with()`, and a hard
 * rule that content never reaches a log line: no credentials, no keystrokes, no
 * clipboard, no pixels, no raw cursor coordinates, no media (SPEC.md §13.4).
 *
 * The Go control plane enforces the same rule in
 * `services/control/internal/logging`; the two lists are kept in step by the
 * tests either side.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const REDACTED = '[redacted]';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const FORBIDDEN_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'credential',
  'apikey',
  'cookie',
  'privatekey',
  'keystroke',
  'keystrokes',
  'keytext',
  'typedtext',
  'clipboard',
  'pixels',
  'frame',
  'framedata',
  'screenshot',
  'audio',
  'video',
  'cursorx',
  'cursory',
  'cursortrail',
  'turnpassword',
];

/** Whether a field name must be redacted before it is written. */
export function isForbiddenKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_.]/g, '');
  return FORBIDDEN_KEYS.some((forbidden) => normalised.includes(forbidden.replace(/_/g, '')));
}

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** Returns a child logger that stamps every line with these fields. */
  with(fields: Fields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Static fields on every line, e.g. component and session id. */
  base?: Fields;
  write?: (line: string) => void;
  now?: () => Date;
}

function redact(fields: Fields): Fields {
  const safe: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isForbiddenKey(key)) {
      safe[key] = REDACTED;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      safe[key] = redact(value as Fields);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const now = options.now ?? (() => new Date());
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (recordLevel: LogLevel, message: string, fields?: Fields) => {
    if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) return;
    const record = {
      time: now().toISOString(),
      level: recordLevel.toUpperCase(),
      msg: message,
      ...redact(base),
      ...redact(fields ?? {}),
    };
    write(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    with: (fields) =>
      createLogger({
        ...options,
        level,
        base: { ...base, ...fields },
      }),
  };
}

/** A random correlation id for a session, request or peer connection. */
export function newCorrelationId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
