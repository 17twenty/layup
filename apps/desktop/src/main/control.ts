import { createControlClient, type ControlClient, type ControlConnectionState } from '../core/control-client';
import type { Logger } from './logging';

/** Where the control plane lives. Overridable for self-hosted deployments. */
export const DEFAULT_CONTROL_URL = 'http://127.0.0.1:8787';

export interface ControlSupervisorOptions {
  baseUrl?: string;
  log: Logger;
  client?: ControlClient;
  /** Probes closer together than this reuse the last answer. */
  minIntervalMs?: number;
  now?: () => number;
}

export interface ControlSupervisor {
  /** Latest connection state, probing only when the cached one is stale. */
  status(): Promise<ControlConnectionState>;
  lastState(): ControlConnectionState | undefined;
}

/**
 * Owns the desktop's view of control-plane connectivity: it debounces probes
 * and logs transitions once, rather than on every poll.
 */
export function createControlSupervisor(options: ControlSupervisorOptions): ControlSupervisor {
  const baseUrl = options.baseUrl ?? DEFAULT_CONTROL_URL;
  const client = options.client ?? createControlClient({ baseUrl });
  const minIntervalMs = options.minIntervalMs ?? 1000;
  const now = options.now ?? (() => Date.now());

  let last: ControlConnectionState | undefined;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<ControlConnectionState> | undefined;

  return {
    lastState: () => last,

    async status() {
      if (last && now() - lastProbeAt < minIntervalMs) return last;
      if (inFlight) return inFlight;

      inFlight = (async () => {
        const state = await client.probe();
        if (!last || last.status !== state.status || last.detail !== state.detail) {
          const fields = {
            controlStatus: state.status,
            baseUrl: state.baseUrl,
            serverProtocolVersion: state.serverProtocolVersion,
            latencyMs: state.latencyMs,
            detail: state.detail,
          };
          if (state.status === 'connected') {
            options.log.info('control plane reachable', fields);
          } else {
            options.log.warn('control plane not usable', fields);
          }
        }
        last = state;
        lastProbeAt = now();
        return state;
      })();

      try {
        return await inFlight;
      } finally {
        inFlight = undefined;
      }
    },
  };
}
