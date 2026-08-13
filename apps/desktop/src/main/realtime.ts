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
export interface RealtimeSupervisorOptions extends Omit<RealtimeClientOptions, 'log'> {
  log: Logger;
  /** Called on every state change, e.g. to push to open windows. */
  onState?: (state: RealtimeState) => void;
}

export interface RealtimeSupervisor {
  start(): void;
  stop(): void;
  state(): RealtimeState;
  client: RealtimeClient;
}

export function createRealtimeSupervisor(options: RealtimeSupervisorOptions): RealtimeSupervisor {
  const { log, onState, ...clientOptions } = options;

  const client = createRealtimeClient({
    ...clientOptions,
    log: {
      debug: (message, fields) => log.debug(message, fields),
      info: (message, fields) => log.info(message, fields),
      warn: (message, fields) => log.warn(message, fields),
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
