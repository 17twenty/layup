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
  isBoolean,
  isEnum,
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

export const VISIBILITIES = ['PRIVATE', 'ORGANISATION', 'LINK'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

const participantShape = isObject({
  membershipId: isString,
  userId: isString,
  displayName: isString,
  joinedAt: isString,
  leftAt: optional(isString),
  isCreatorMembership: isBoolean,
});

export const layupShape = isObject({
  id: isString,
  organisationId: isString,
  title: optional(isString),
  visibility: isEnum(VISIBILITIES),
  active: isBoolean,
  createdAt: isString,
  endedAt: optional(isString),
  hasCreatorAuthority: isBoolean,
  creatorMembershipId: optional(isString),
  participants: isArrayOf(participantShape, { max: 200 }),
});
export type Layup = ReturnType<typeof layupShape>;
export type Participant = ReturnType<typeof participantShape>;

const membershipResultShape = isObject({
  layup: layupShape,
  yourMembershipId: isString,
});
export type MembershipResult = ReturnType<typeof membershipResultShape>;

export const REQUEST_TYPES = [
  'INVITE_USER_TO_NEW_LAYUP',
  'INVITE_USER_TO_LAYUP',
  'KNOCK_TO_JOIN',
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATES = ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const joinRequestShape = isObject({
  id: isString,
  type: isEnum(REQUEST_TYPES),
  state: isEnum(REQUEST_STATES),
  fromUserId: isString,
  fromName: isString,
  toUserId: optional(isString),
  toName: optional(isString),
  note: optional(isString),
  createdAt: isString,
  expiresAt: isString,
  layupId: optional(isString),
  layupTitle: optional(isString),
  resultLayupId: optional(isString),
});
export type JoinRequest = ReturnType<typeof joinRequestShape>;

const requestListShape = isObject({
  incoming: isArrayOf(joinRequestShape, { max: 100 }),
  outgoing: isArrayOf(joinRequestShape, { max: 100 }),
});
export type RequestList = ReturnType<typeof requestListShape>;

const acceptResultShape = isObject({
  request: joinRequestShape,
  layup: layupShape,
  yourMembershipId: isString,
});
export type AcceptResult = ReturnType<typeof acceptResultShape>;

export const openLayupShape = isObject({
  id: isString,
  title: optional(isString),
  participantCount: isInteger({ min: 0 }),
  participants: isArrayOf(isString, { max: 200 }),
  presenterName: optional(isString),
  canJoin: isBoolean,
  youAreInIt: isBoolean,
});

const iceServerShape = isObject({
  urls: isArrayOf(isString, { max: 20 }),
  username: optional(isString),
  credential: optional(isString),
});

const iceConfigurationShape = isObject({
  iceServers: isArrayOf(iceServerShape, { max: 20 }),
  expiresAt: isString,
  forceRelay: isBoolean,
});
export type IceConfiguration = ReturnType<typeof iceConfigurationShape>;

const invitationLinkShape = isObject({ token: isString, expiresAt: isString });
export type InvitationLink = ReturnType<typeof invitationLinkShape>;

const openLayupsShape = isObject({ layups: isArrayOf(openLayupShape, { max: 200 }) });
export type OpenLayups = ReturnType<typeof openLayupsShape>;

export interface CreateRequestInput {
  type: RequestType;
  toUserId?: string;
  layupId?: string;
  note?: string;
}

export interface CreateLayupInput {
  title?: string;
  visibility?: Visibility;
}

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
  /** Versioned API command. Throws ControlRequestError on a non-2xx response. */
  apiPost<T>(path: string, body?: unknown): Promise<T>;
  /** Who the control plane thinks this desktop is. */
  me(): Promise<MeSnapshot>;
  /** The people in this organisation. */
  directory(): Promise<DirectorySnapshot>;
  /** Creates a layup with the caller as the creator membership. */
  createLayup(input?: CreateLayupInput): Promise<MembershipResult>;
  /** Joins an existing layup. */
  joinLayup(layupId: string): Promise<MembershipResult>;
  /** Ends the caller's own membership. Nobody can remove anyone else. */
  leaveLayup(layupId: string): Promise<MembershipResult>;
  /** Reads current layup state. */
  getLayup(layupId: string): Promise<Layup>;
  /** Organisation-open layups (Happening Now). */
  openLayups(): Promise<OpenLayups>;
  /** ICE servers plus short-lived TURN credentials, and the relay policy. */
  turnCredentials(): Promise<IceConfiguration>;
  /** Mints an opaque invitation link for a layup you are in. */
  createLink(layupId: string): Promise<InvitationLink>;
  /** Joins a layup using an invitation link token. */
  joinByLink(token: string): Promise<MembershipResult>;
  /** Sends an invitation or knock. */
  createRequest(input: CreateRequestInput): Promise<JoinRequest>;
  /** Pending requests to and from this user. */
  listRequests(): Promise<RequestList>;
  /** Accepts an invitation or admits a knocker. */
  acceptRequest(requestId: string): Promise<AcceptResult>;
  /** Declines a request addressed to you. */
  declineRequest(requestId: string): Promise<JoinRequest>;
  /** Cancels a request you sent. */
  cancelRequest(requestId: string): Promise<JoinRequest>;
}

export function createControlClient(options: ControlClientOptions): ControlClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  const now = options.now ?? (() => Date.now());

  function apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      Accept: 'application/json',
    };
    if (options.devUser) headers[DEV_USER_HEADER] = options.devUser;
    return headers;
  }

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

    async createLayup(input: CreateLayupInput = {}): Promise<MembershipResult> {
      const envelope = await this.apiPost<{ payload?: unknown }>('/api/layups', {
        title: input.title ?? '',
        visibility: input.visibility ?? 'PRIVATE',
      });
      return membershipResultShape(envelope.payload, 'layup.created');
    },

    async joinLayup(layupId: string): Promise<MembershipResult> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/layups/${encodeURIComponent(layupId)}/join`,
      );
      return membershipResultShape(envelope.payload, 'layup.joined');
    },

    async leaveLayup(layupId: string): Promise<MembershipResult> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/layups/${encodeURIComponent(layupId)}/leave`,
      );
      return membershipResultShape(envelope.payload, 'layup.left');
    },

    async getLayup(layupId: string): Promise<Layup> {
      const envelope = await this.apiGet<{ payload?: unknown }>(
        `/api/layups/${encodeURIComponent(layupId)}`,
      );
      return layupShape(envelope.payload, 'layup.state');
    },

    async createRequest(input: CreateRequestInput): Promise<JoinRequest> {
      const envelope = await this.apiPost<{ payload?: unknown }>('/api/requests', {
        type: input.type,
        toUserId: input.toUserId ?? '',
        layupId: input.layupId ?? '',
        note: input.note ?? '',
      });
      return joinRequestShape(envelope.payload, 'request.created');
    },

    async listRequests(): Promise<RequestList> {
      const envelope = await this.apiGet<{ payload?: unknown }>('/api/requests');
      return requestListShape(envelope.payload, 'request.list');
    },

    async acceptRequest(requestId: string): Promise<AcceptResult> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/requests/${encodeURIComponent(requestId)}/accept`,
      );
      return acceptResultShape(envelope.payload, 'request.accepted');
    },

    async declineRequest(requestId: string): Promise<JoinRequest> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/requests/${encodeURIComponent(requestId)}/decline`,
      );
      return joinRequestShape(envelope.payload, 'request.resolved');
    },

    async cancelRequest(requestId: string): Promise<JoinRequest> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/requests/${encodeURIComponent(requestId)}/cancel`,
      );
      return joinRequestShape(envelope.payload, 'request.resolved');
    },

    async turnCredentials(): Promise<IceConfiguration> {
      const envelope = await this.apiGet<{ payload?: unknown }>('/api/turn');
      return iceConfigurationShape(envelope.payload, 'turn.credentials');
    },

    async createLink(layupId: string): Promise<InvitationLink> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/layups/${encodeURIComponent(layupId)}/link`,
      );
      return invitationLinkShape(envelope.payload, 'layup.link');
    },

    async joinByLink(token: string): Promise<MembershipResult> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/links/${encodeURIComponent(token)}/join`,
      );
      return membershipResultShape(envelope.payload, 'layup.joined');
    },

    async openLayups(): Promise<OpenLayups> {
      const envelope = await this.apiGet<{ payload?: unknown }>('/api/layups');
      return openLayupsShape(envelope.payload, 'layup.open');
    },

    async apiPost<T>(path: string, body?: unknown): Promise<T> {
      const response = await withTimeout(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: body === undefined ? '{}' : JSON.stringify(body),
      });
      if (!response.ok) {
        const parsed = await response.json().catch(() => undefined);
        const code = extractErrorCode(parsed);
        throw new ControlRequestError(
          `POST ${path} failed with HTTP ${response.status}${code ? ` (${code})` : ''}`,
          response.status,
          code,
        );
      }
      return (await response.json()) as T;
    },

    async apiGet<T>(path: string): Promise<T> {
      const response = await withTimeout(`${baseUrl}${path}`, { method: 'GET', headers: apiHeaders() });
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
