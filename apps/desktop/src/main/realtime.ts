import {
  createRealtimeClient,
  type RealtimeClient,
  type RealtimeClientOptions,
  type RealtimeState,
} from '../core/realtime-client';
import type { Logger } from './logging';

/**
 * Main-process owner of the realtime connection.
 *
 * The renderer never opens a socket itself: the privileged process owns session
 * state and pushes validated updates across the bridge (ARCHITECTURE.md §2).
 */
export interface RealtimeSupervisorOptions
  extends Omit<RealtimeClientOptions, 'log' | 'baseUrl' | 'token'> {
  log: Logger;
  /** Called on every state change, e.g. to push to open windows. */
  onState?: (state: RealtimeState) => void;
  /**
   * Where to connect. A function is read again on every connect, so adding a
   * server moves the socket to it on the next start without a restart.
   */
  baseUrl: string | (() => string);
  /** Bearer token, read the same way and for the same reason. */
  token?: string | (() => string | undefined);
}

export interface RealtimeSupervisor {
  start(): void;
  stop(): void;
  state(): RealtimeState;
  client: RealtimeClient;
}

export function createRealtimeSupervisor(options: RealtimeSupervisorOptions): RealtimeSupervisor {
  const { log, onState, baseUrl, token, ...clientOptions } = options;

  // Accessors, not values: the client reads them when it opens a socket, which
  // is after somebody may have added a server.
  const client = createRealtimeClient({
    ...clientOptions,
    log: {
      debug: (message, fields) => log.debug(message, fields),
      info: (message, fields) => log.info(message, fields),
      warn: (message, fields) => log.warn(message, fields),
    },
    get baseUrl() {
      return typeof baseUrl === 'function' ? baseUrl() : baseUrl;
    },
    get token() {
      return typeof token === 'function' ? token() : token;
    },
  });

  let lastStatus: RealtimeState['status'] | undefined;
  client.onStatus((state) => {
    if (state.status !== lastStatus) {
      lastStatus = state.status;
      const fields = {
        realtimeStatus: state.status,
        attempt: state.attempt,
        connectionId: state.connectionId,
        reason: state.lastError,
      };
      if (state.status === 'connected') log.info('realtime state', fields);
      else log.warn('realtime state', fields);
    }
    onState?.(state);
  });

  return {
    start: () => client.start(),
    stop: () => client.stop(),
    state: () => client.state(),
    client,
  };
}
