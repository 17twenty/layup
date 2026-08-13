/**
 * Client for the Go control plane.
 *
 * Framework-free on purpose: it runs in the Electron main process, in unit
 * tests and in the smoke harness without an Electron or DOM dependency.
 *
 * The control plane owns social/session state only. Media never flows through
 * here (ARCHITECTURE.md §3.1).
 */
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  ValidationError,
  isArrayOf,
  isFiniteNumber,
  isInteger,
  isObject,
  isString,
  optional,
} from '@layup/protocol';

export type ControlStatus = 'connected' | 'unreachable' | 'incompatible';

export interface ControlConnectionState {
  status: ControlStatus;
  baseUrl: string;
  clientProtocolVersion: number;
  /** Present once the server has answered at least the health endpoint. */
  serverProtocolVersion?: number;
  serverVersion?: string;
  environment?: string;
  latencyMs?: number;
  /** Human-readable reason when the status is not `connected`. */
  detail?: string;
  checkedAtMs: number;
}

const healthShape = isObject({
  status: isString,
  protocolVersion: isInteger({ min: 1 }),
  environment: optional(isString),
  // Fractional: the server reports real uptime, not whole seconds.
  uptimeSeconds: optional(isFiniteNumber),
  build: optional(
    isObject({
      version: isString,
      commit: optional(isString),
      goVersion: optional(isString),
      platform: optional(isString),
    }),
  ),
});

export interface ControlClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Requests are abandoned after this long; an unreachable server must not hang the UI. */
  timeoutMs?: number;
  now?: () => number;
  /**
   * PLAN-1 development identity: a handle ("karl") or user id. There is no
   * password or token yet - the server resolves it against its directory and
   * decides the organisation itself.
   */
  devUser?: string;
}

/** Header carrying the PLAN-1 development identity. */
export const DEV_USER_HEADER = 'X-Layup-Dev-User';

export interface DirectoryUser {
  id: string;
  displayName: string;
  avatarUrl?: string;
  statusMessage?: string;
}

export interface DirectoryOrganisation {
  id: string;
  name: string;
}

export interface DirectorySnapshot {
  organisation: DirectoryOrganisation;
  users: DirectoryUser[];
}

export interface MeSnapshot {
  user: DirectoryUser;
  organisation: DirectoryOrganisation;
}

const userShape = isObject({
  id: isString,
  displayName: isString,
  avatarUrl: optional(isString),
  statusMessage: optional(isString),
});

const organisationShape = isObject({ id: isString, name: isString });

const directoryShape = isObject({
  organisation: organisationShape,
  users: isArrayOf(userShape, { max: 500 }),
});

const meShape = isObject({ user: userShape, organisation: organisationShape });

export class ControlRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ControlRequestError';
    this.status = status;
    this.code = code;
  }
}

export interface ControlClient {
  readonly baseUrl: string;
  /** Health check plus protocol compatibility, never throwing for the caller. */
  probe(): Promise<ControlConnectionState>;
  /** Versioned API call. Throws ControlRequestError on a non-2xx response. */
  apiGet<T>(path: string): Promise<T>;
  /** Who the control plane thinks this desktop is. */
  me(): Promise<MeSnapshot>;
  /** The people in this organisation. */
  directory(): Promise<DirectorySnapshot>;
}

export function createControlClient(options: ControlClientOptions): ControlClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  const now = options.now ?? (() => Date.now());

  async function withTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl,

    async probe(): Promise<ControlConnectionState> {
      const startedAt = now();
      const base: ControlConnectionState = {
        status: 'unreachable',
        baseUrl,
        clientProtocolVersion: PROTOCOL_VERSION,
        checkedAtMs: startedAt,
      };

      let response: Response;
      try {
        // /healthz is deliberately unversioned so a mismatched client can still
        // discover what the server speaks.
        response = await withTimeout(`${baseUrl}/healthz`, { method: 'GET' });
      } catch (cause) {
        return { ...base, detail: describeNetworkFailure(cause, timeoutMs) };
      }

      const latencyMs = now() - startedAt;

      if (!response.ok) {
        return { ...base, latencyMs, detail: `control service returned HTTP ${response.status}` };
      }

      let health: ReturnType<typeof healthShape>;
      try {
        health = healthShape(await response.json(), 'healthz');
      } catch (cause) {
        const detail = cause instanceof ValidationError ? cause.message : String(cause);
        return { ...base, latencyMs, detail: `unrecognised health response (${detail})` };
      }

      const common = {
        baseUrl,
        clientProtocolVersion: PROTOCOL_VERSION,
        serverProtocolVersion: health.protocolVersion,
        serverVersion: health.build?.version,
        environment: health.environment,
        latencyMs,
        checkedAtMs: startedAt,
      };

      if (health.protocolVersion !== PROTOCOL_VERSION) {
        return {
          ...common,
          status: 'incompatible',
          detail: `server speaks protocol v${health.protocolVersion}, this desktop speaks v${PROTOCOL_VERSION}`,
        };
      }
      if (health.status !== 'ok') {
        return { ...common, status: 'unreachable', detail: `control service reported "${health.status}"` };
      }
      return { ...common, status: 'connected' };
    },

    async me(): Promise<MeSnapshot> {
      const envelope = await this.apiGet<{ payload?: unknown }>('/api/me');
      return meShape(envelope.payload, 'identity.me');
    },

    async directory(): Promise<DirectorySnapshot> {
      const envelope = await this.apiGet<{ payload?: unknown }>('/api/directory');
      return directoryShape(envelope.payload, 'directory.users');
    },

    async apiGet<T>(path: string): Promise<T> {
      const headers: Record<string, string> = {
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        Accept: 'application/json',
      };
      if (options.devUser) headers[DEV_USER_HEADER] = options.devUser;

      const response = await withTimeout(`${baseUrl}${path}`, { method: 'GET', headers });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        const code = extractErrorCode(body);
        throw new ControlRequestError(
          `GET ${path} failed with HTTP ${response.status}${code ? ` (${code})` : ''}`,
          response.status,
          code,
        );
      }
      return (await response.json()) as T;
    },
  };
}

function describeNetworkFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error && cause.name === 'AbortError') {
    return `control service did not answer within ${timeoutMs}ms`;
  }
  const reason = cause instanceof Error ? cause.message : String(cause);
  return `control service unreachable (${reason})`;
}

function extractErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const payload = (body as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
