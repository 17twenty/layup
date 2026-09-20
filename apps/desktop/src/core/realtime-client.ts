/**
 * Realtime client for the control plane.
 *
 * Responsibilities, in the order they matter:
 *   1. stay connected, with backoff, forever;
 *   2. notice a dead connection quickly (heartbeat watchdog);
 *   3. reconnect without duplicating subscriptions;
 *   4. reject malformed events instead of acting on them.
 *
 * It carries control-plane events only. Cursors, drawing, input and media go
 * over WebRTC data channels (ARCHITECTURE.md §3.2).
 */
import {
  PROTOCOL_VERSION,
  QUERY_DEV_USER,
  QUERY_PROTOCOL_VERSION,
  QUERY_TOKEN,
  TYPE_HEARTBEAT,
  TYPE_HEARTBEAT_ACK,
  TYPE_HELLO_OK,
  decodeEnvelope,
  envelope,
  heartbeatPayload,
  helloOkPayload,
  type Envelope,
} from '@layup/protocol';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface RealtimeState {
  status: RealtimeStatus;
  /** Present once the server has said hello. */
  connectionId?: string;
  userId?: string;
  organisationId?: string;
  attempt: number;
  lastError?: string;
  lastMessageAtMs?: number;
}

/** The subset of WebSocket this client needs, so tests can supply a fake. */
export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface RealtimeLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface RealtimeClientOptions {
  baseUrl: string;
  devUser: string;
  /** Bearer token from the desktop's config store. Takes priority over `devUser`. */
  token?: string;
  socketFactory?: (url: string) => RealtimeSocket;
  /** Connection is considered dead after heartbeatInterval * this factor. */
  heartbeatTimeoutFactor?: number;
  /** Fallback watchdog window before the server has told us its interval. */
  initialHeartbeatMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  now?: () => number;
  log?: RealtimeLogger;
}

export type EnvelopeHandler = (message: Envelope) => void;
export type StatusHandler = (state: RealtimeState) => void;

export interface RealtimeClient {
  start(): void;
  stop(): void;
  state(): RealtimeState;
  /** Subscribe to one message type. Returns an unsubscribe function. */
  on(type: string, handler: EnvelopeHandler): () => void;
  /** Subscribe to connection-state changes. Returns an unsubscribe function. */
  onStatus(handler: StatusHandler): () => void;
  send(message: Envelope): boolean;
}

const noopLogger: RealtimeLogger = { debug: () => {}, info: () => {}, warn: () => {} };

export function realtimeUrl(baseUrl: string, devUser: string, token?: string): string {
  const url = new URL(baseUrl.replace(/\/+$/, '') + '/api/realtime');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set(QUERY_PROTOCOL_VERSION, String(PROTOCOL_VERSION));
  if (token) {
    url.searchParams.set(QUERY_TOKEN, token);
  } else {
    url.searchParams.set(QUERY_DEV_USER, devUser);
  }
  return url.toString();
}

export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  const log = options.log ?? noopLogger;
  const now = options.now ?? (() => Date.now());
  const heartbeatFactor = options.heartbeatTimeoutFactor ?? 3;
  const initialHeartbeatMs = options.initialHeartbeatMs ?? 5000;
  const reconnectBaseMs = options.reconnectBaseMs ?? 500;
  const reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
  const socketFactory =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as RealtimeSocket);

  // Subscriptions live on the client, not on the socket, so a reconnect never
  // re-registers or drops a handler.
  const handlers = new Map<string, Set<EnvelopeHandler>>();
  const statusHandlers = new Set<StatusHandler>();

  let socket: RealtimeSocket | undefined;
  let state: RealtimeState = { status: 'idle', attempt: 0 };
  let stopped = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatIntervalMs = initialHeartbeatMs;

  function setState(next: Partial<RealtimeState>) {
    state = { ...state, ...next };
    for (const handler of statusHandlers) handler(state);
  }

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    reconnectTimer = undefined;
    watchdogTimer = undefined;
  }

  function armWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      // No heartbeat and no traffic: the socket may be half-open, where a TCP
      // connection looks alive but nothing is flowing.
      log.warn('realtime heartbeat missed', { afterMs: heartbeatIntervalMs * heartbeatFactor });
      dropAndReconnect('heartbeat timeout');
    }, heartbeatIntervalMs * heartbeatFactor);
  }

  function dropAndReconnect(reason: string) {
    if (stopped) return;
    const dying = socket;
    socket = undefined;
    if (dying) {
      dying.onopen = null;
      dying.onclose = null;
      dying.onerror = null;
      dying.onmessage = null;
      try {
        dying.close(4000, reason.slice(0, 100));
      } catch {
        // Closing a socket that is already gone is not an error worth raising.
      }
    }
    scheduleReconnect(reason);
  }

  function scheduleReconnect(reason: string) {
    if (stopped) return;
    const attempt = state.attempt + 1;
    // Exponential backoff with jitter so many clients do not resynchronise
    // onto the server the instant it comes back.
    const backoff = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** (attempt - 1));
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    setState({ status: 'reconnecting', attempt, lastError: reason });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function dispatch(message: Envelope) {
    const subscribers = handlers.get(message.type);
    if (!subscribers) return;
    for (const handler of subscribers) {
      try {
        handler(message);
      } catch (error) {
        // One bad subscriber must not tear down the connection.
        log.warn('realtime handler threw', {
          type: message.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function handleMessage(raw: unknown) {
    let message: Envelope;
    try {
      message = decodeEnvelope(typeof raw === 'string' ? raw : String(raw));
    } catch (error) {
      // Rejected, not repaired, and never fatal.
      log.warn('rejected realtime message', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    setState({ lastMessageAtMs: now() });
    armWatchdog();

    if (message.type === TYPE_HELLO_OK) {
      try {
        const hello = helloOkPayload(message.payload, 'hello.ok');
        heartbeatIntervalMs = hello.heartbeatIntervalMs;
        setState({
          status: 'connected',
          attempt: 0,
          connectionId: hello.connectionId,
          userId: hello.userId,
          organisationId: hello.organisationId,
          lastError: undefined,
        });
        armWatchdog();
        log.info('realtime connected', { connectionId: hello.connectionId, userId: hello.userId });
      } catch (error) {
        dropAndReconnect(`invalid hello: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else if (message.type === TYPE_HEARTBEAT) {
      try {
        const beat = heartbeatPayload(message.payload, 'heartbeat');
        send(envelope(TYPE_HEARTBEAT_ACK, { seq: beat.seq }));
      } catch (error) {
        log.warn('rejected heartbeat', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    dispatch(message);
  }

  function connect() {
    if (stopped) return;
    setState({ status: state.attempt === 0 ? 'connecting' : 'reconnecting' });

    let next: RealtimeSocket;
    try {
      next = socketFactory(realtimeUrl(options.baseUrl, options.devUser, options.token));
    } catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    socket = next;

    next.onopen = () => {
      log.debug('realtime socket open');
      armWatchdog();
    };
    next.onmessage = (event) => handleMessage(event.data);
    next.onerror = () => {
      // onclose follows; recording the reason here keeps the state honest.
      setState({ lastError: 'socket error' });
    };
    next.onclose = (event) => {
      if (socket !== next) return;
      socket = undefined;
      if (watchdogTimer) clearTimeout(watchdogTimer);
      scheduleReconnect(event?.reason || `socket closed (${event?.code ?? 'no code'})`);
    };
  }

  function send(message: Envelope): boolean {
    if (!socket) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log.warn('realtime send failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      setState({ status: 'connecting', attempt: 0, lastError: undefined });
      connect();
    },

    stop() {
      stopped = true;
      clearTimers();
      const dying = socket;
      socket = undefined;
      if (dying) {
        dying.onclose = null;
        dying.onmessage = null;
        dying.onerror = null;
        dying.onopen = null;
        try {
          dying.close(1000, 'client stopped');
        } catch {
          // Already gone.
        }
      }
      setState({ status: 'stopped', connectionId: undefined });
    },

    state: () => state,

    on(type, handler) {
      let subscribers = handlers.get(type);
      if (!subscribers) {
        subscribers = new Set();
        handlers.set(type, subscribers);
      }
      subscribers.add(handler);
      return () => {
        subscribers?.delete(handler);
        if (subscribers && subscribers.size === 0) handlers.delete(type);
      };
    },

    onStatus(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },

    send,
  };
}
