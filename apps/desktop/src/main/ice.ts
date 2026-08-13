import type { ControlClient, IceConfiguration } from '../core/control-client';
import type { Logger } from './logging';

/**
 * ICE configuration for peer connections.
 *
 * The control plane issues short-lived TURN credentials and says whether policy
 * forces relay; this caches them until they expire. `LAYUP_FORCE_RELAY=true`
 * forces relay locally as well, which is how the TURN path stays continuously
 * verifiable rather than being exercised once by hand (SPEC.md §10.3).
 */
export interface IceSupervisorOptions {
  client: ControlClient;
  log: Logger;
  /** Local override, independent of server policy. */
  forceRelay?: boolean;
  now?: () => number;
  /** Refresh this long before the credentials actually expire. */
  refreshMarginMs?: number;
}

export interface IceState extends IceConfiguration {
  /** True when either server policy or the local override forces relay. */
  forceRelay: boolean;
  /** Why relay is forced, for the diagnostics view. */
  forcedBy?: 'policy' | 'local';
}

export interface IceSupervisor {
  /** Current configuration, fetching or refreshing when needed. */
  configuration(): Promise<IceState>;
  /** Last configuration, without touching the network. */
  last(): IceState | undefined;
}

/** Fallback used only when the control plane cannot be reached. */
const STUN_ONLY: IceConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  expiresAt: new Date(0).toISOString(),
  forceRelay: false,
};

export function createIceSupervisor(options: IceSupervisorOptions): IceSupervisor {
  const now = options.now ?? (() => Date.now());
  const margin = options.refreshMarginMs ?? 60_000;

  let cached: IceState | undefined;
  let inFlight: Promise<IceState> | undefined;

  const decorate = (config: IceConfiguration): IceState => {
    const forceRelay = config.forceRelay || options.forceRelay === true;
    return {
      ...config,
      forceRelay,
      ...(forceRelay ? { forcedBy: config.forceRelay ? ('policy' as const) : ('local' as const) } : {}),
    };
  };

  const fresh = (state: IceState) => Date.parse(state.expiresAt) - now() > margin;

  return {
    last: () => cached,

    async configuration() {
      if (cached && fresh(cached)) return cached;
      if (inFlight) return inFlight;

      inFlight = (async () => {
        try {
          const config = await options.client.turnCredentials();
          cached = decorate(config);
          options.log.info('ice configuration refreshed', {
            servers: config.iceServers.length,
            // Never the credential itself, only whether one was issued. The
            // field is named to survive redaction, which is name-based.
            turnAuthIssued: config.iceServers.some((server) => Boolean(server.username)),
            forceRelay: cached.forceRelay,
            forcedBy: cached.forcedBy,
            expiresAt: config.expiresAt,
          });
        } catch (error) {
          // A missing configuration must not silently become "direct only":
          // if relay is forced locally, that still holds with no TURN server,
          // and the connection will fail loudly instead of quietly going direct.
          cached = decorate({ ...STUN_ONLY, forceRelay: options.forceRelay === true });
          options.log.warn('could not fetch ICE configuration; using STUN only', {
            reason: error instanceof Error ? error.message : String(error),
            forceRelay: cached.forceRelay,
          });
        }
        return cached;
      })();

      try {
        return await inFlight;
      } finally {
        inFlight = undefined;
      }
    },
  };
}
