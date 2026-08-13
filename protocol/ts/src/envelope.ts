/**
 * The single wire shape for every realtime and API message.
 *
 *   {"v":1,"type":"presence.update","id":"...","payload":{...}}
 *
 * Mirrors protocol/go/envelope.go. Neither side coerces: an unsupported or
 * malformed envelope is an error, never a repaired default.
 */
import { ValidationError, isInteger, isString } from './validate';

/** Protocol version spoken by this build. Must match protocol/VERSION. */
export const PROTOCOL_VERSION = 1;

/** Header carrying the protocol version on control-plane HTTP requests. */
export const PROTOCOL_HEADER = 'X-Layup-Protocol-Version';

/** Envelope type used to report a failure to a peer. */
export const TYPE_ERROR = 'error';

export const ERROR_CODES = [
  'unsupported_protocol_version',
  'malformed_message',
  'unknown_message_type',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Envelope<P = unknown> {
  v: number;
  type: string;
  id?: string;
  payload?: P;
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  serverVersion?: number;
  receivedVersion?: number;
}

/** Whether this build can serve the given version. */
export function supportsVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
}

export class ProtocolVersionError extends Error {
  readonly receivedVersion: number;
  readonly supportedVersion = PROTOCOL_VERSION;

  constructor(receivedVersion: number) {
    super(`unsupported protocol version: peer speaks v${receivedVersion}, this build speaks v${PROTOCOL_VERSION}`);
    this.name = 'ProtocolVersionError';
    this.receivedVersion = receivedVersion;
  }
}

/** Builds an envelope stamped with this build's version. */
export function envelope<P>(type: string, payload?: P, id?: string): Envelope<P> {
  const message: Envelope<P> = { v: PROTOCOL_VERSION, type };
  if (payload !== undefined) message.payload = payload;
  if (id !== undefined) message.id = id;
  return message;
}

/** Parses and validates an envelope. Throws ProtocolVersionError or ValidationError. */
export function decodeEnvelope(raw: unknown): Envelope {
  const source = typeof raw === 'string' ? parseJson(raw) : raw;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new ValidationError('envelope', 'expected an object');
  }
  const record = source as Record<string, unknown>;
  const version = isInteger({ min: 1 })(record.v, 'envelope.v');
  if (!supportsVersion(version)) {
    throw new ProtocolVersionError(version);
  }
  const type = isString(record.type, 'envelope.type');
  if (type.length === 0) {
    throw new ValidationError('envelope.type', 'must not be empty');
  }
  const result: Envelope = { v: version, type };
  if (record.id !== undefined) result.id = isString(record.id, 'envelope.id');
  if (record.payload !== undefined) result.payload = record.payload;
  return result;
}

/** Builds a TYPE_ERROR envelope. */
export function errorEnvelope(code: ErrorCode, message: string, receivedVersion?: number): Envelope<ErrorPayload> {
  const payload: ErrorPayload = { code, message, serverVersion: PROTOCOL_VERSION };
  if (receivedVersion !== undefined) payload.receivedVersion = receivedVersion;
  return envelope(TYPE_ERROR, payload);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ValidationError('envelope', `not valid JSON: ${String(cause)}`);
  }
}
