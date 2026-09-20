/**
 * Realtime message types carried inside the shared envelope over WSS.
 *
 * Control plane only: presence, membership, social requests and signalling.
 * Media and cursor traffic never travel here (ARCHITECTURE.md §3).
 *
 * Mirrors protocol/go/realtime.go.
 */
import { isInteger, isObject, isString } from './validate';

export const TYPE_HELLO_OK = 'hello.ok';
export const TYPE_HEARTBEAT = 'heartbeat';
export const TYPE_HEARTBEAT_ACK = 'heartbeat.ack';

/** Handshake travels on the URL: the desktop's WebSocket cannot set headers. */
export const QUERY_PROTOCOL_VERSION = 'v';
export const QUERY_DEV_USER = 'devUser';
/**
 * A bearer token on the handshake URL. Safe only under TLS, and only while it
 * never reaches a log.
 */
export const QUERY_TOKEN = 'token';

export const helloOkPayload = isObject({
  connectionId: isString,
  userId: isString,
  organisationId: isString,
  protocolVersion: isInteger({ min: 1 }),
  heartbeatIntervalMs: isInteger({ min: 100 }),
});
export type HelloOkPayload = ReturnType<typeof helloOkPayload>;

export const heartbeatPayload = isObject({ seq: isInteger({ min: 0 }) });
export type HeartbeatPayload = ReturnType<typeof heartbeatPayload>;
