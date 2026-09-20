import {
  createControlClient,
  isCredentialRejection,
  type ControlClient,
  type ControlConnectionState,
} from '../core/control-client';
import type { Logger } from './logging';

/** Where the control plane lives. Overridable for self-hosted deployments. */
export const DEFAULT_CONTROL_URL = 'http://127.0.0.1:8787';

/**
 * PLAN-1 identity is a development handle, chosen with LAYUP_DEV_USER. Running
 * two clients on one machine is `LAYUP_DEV_USER=nick` and `LAYUP_DEV_USER=karl`.
 * There are no secrets to configure - real identity is PLAN-2.
 */
export const DEFAULT_DEV_USER = 'nick';

/** The identity this desktop is running as, as far as the server agrees. */
export interface IdentityState {
  devUser: string;
  resolved: boolean;
  userId?: string;
  displayName?: string;
  organisationId?: string;
  organisationName?: string;
  /** Why the identity could not be resolved, when resolved is false. */
  detail?: string;
  /**
   * Set when the server refused this desktop's credential outright (401/403),
   * as opposed to not answering at all. The two need opposite responses -
   * throw the config away, or keep it and wait - so they are two fields and
   * not one.
   */
  credentialsRejected?: boolean;
}

export interface ControlSupervisorOptions {
  baseUrl?: string;
  log: Logger;
  client?: ControlClient;
  /** Probes closer together than this reuse the last answer. */
  minIntervalMs?: number;
  now?: () => number;
  devUser?: string;
  /**
   * Called when the server says it does not recognise this desktop's
   * credential. Called once per rejection, so the caller can clear the stored
   * config and stop trying rather than reconnecting into a refusal for ever.
   */
  onCredentialsRejected?: () => void;
}

export interface ControlSupervisor {
  /** Latest connection state, probing only when the cached one is stale. */
  status(): Promise<ControlConnectionState>;
  lastState(): ControlConnectionState | undefined;
  /** Who this desktop is running as. */
  identity(): Promise<IdentityState>;
}

/**
 * Owns the desktop's view of control-plane connectivity: it debounces probes
 * and logs transitions once, rather than on every poll.
 */
export function createControlSupervisor(options: ControlSupervisorOptions): ControlSupervisor {
  const baseUrl = options.baseUrl ?? DEFAULT_CONTROL_URL;
  const devUser = options.devUser ?? DEFAULT_DEV_USER;
  const client = options.client ?? createControlClient({ baseUrl, devUser });
  const minIntervalMs = options.minIntervalMs ?? 1000;
  const now = options.now ?? (() => Date.now());

  let last: ControlConnectionState | undefined;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<ControlConnectionState> | undefined;
  let identityState: IdentityState | undefined;

  return {
    lastState: () => last,

    async identity() {
      if (identityState?.resolved) return identityState;
      try {
        const me = await client.me();
        identityState = {
          devUser,
          resolved: true,
          userId: me.user.id,
          displayName: me.user.displayName,
          organisationId: me.organisation.id,
          organisationName: me.organisation.name,
        };
        options.log.info('identity resolved', {
          devUser,
          userId: me.user.id,
          organisationId: me.organisation.id,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const rejected = isCredentialRejection(error);
        // An unresolved identity is a normal state while the server is down,
        // and nothing to act on. A *refused credential* is the opposite: this
        // desktop's token will never work again, and carrying on with it is
        // the reconnect loop that had to be fixed by deleting config.json.
        identityState = { devUser, resolved: false, detail, ...(rejected ? { credentialsRejected: true } : {}) };
        if (rejected) {
          options.log.warn('the server does not recognise this desktop', { devUser, detail });
          options.onCredentialsRejected?.();
        }
      }
      return identityState;
    },

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
