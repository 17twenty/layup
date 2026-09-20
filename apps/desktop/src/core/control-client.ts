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
  latencyMs?: number;
  /** Human-readable reason when the status is not `connected`. */
  detail?: string;
  checkedAtMs: number;
}

const healthShape = isObject({
  status: isString,
  protocolVersion: isInteger({ min: 1 }),
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
   *
   * Ignored once a `token` is present.
   */
  devUser?: string;
  /** Bearer token from the desktop's config store. Takes priority over `devUser`. */
  token?: string;
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
  /**
   * Whether this membership is a browser visitor who arrived by link.
   *
   * Required, not optional, and that is the whole point. This is what
   * `input-guard.ts` and `annotation-guard.ts` key off, and it is the only
   * thing standing between a stranger holding a URL and somebody's mouse.
   * Absent used to read as "not a guest" - which is exactly what a layup with
   * no guests in it looks like, so a server that stopped sending it, or a
   * version skew that dropped it, would have softened the refusal silently.
   *
   * A missing one is now a loud validation error instead: the shape already
   * rejects a property nobody knows about, and it should be at least as
   * strict about a missing one a security check depends on.
   */
  isGuest: isBoolean,
});

const activeShareShape = isObject({
  id: isString,
  presenterMembershipId: isString,
  presenterName: optional(isString),
  sourceId: optional(isString),
  allowDrawing: isBoolean,
  allowPointer: isBoolean,
  allowKeyboard: isBoolean,
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
  /**
   * The shared desktop, when there is one. Absent is the normal state.
   *
   * Unknown properties are rejected rather than ignored, which is the right
   * default and also means a field the server sends and this does not know
   * about takes the whole layup down with it - as this one did, silently
   * stopping every state update the moment anybody shared.
   */
  activeShare: optional(activeShareShape),
});
export type Layup = ReturnType<typeof layupShape>;
export type Participant = ReturnType<typeof participantShape>;

const joinMediaShape = isObject({
  camera: isBoolean,
  microphone: isBoolean,
  participantCount: isInteger({ min: 0 }),
  mutedByThreshold: isBoolean,
});
export type JoinMedia = ReturnType<typeof joinMediaShape>;

const membershipResultShape = isObject({
  layup: layupShape,
  yourMembershipId: isString,
  media: optional(joinMediaShape),
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
  media: optional(joinMediaShape),
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

/**
 * Did the server refuse *this credential*, or could it just not be asked?
 *
 * This is the whole of the difference between "your token is dead, add the
 * server again" and "wait". Only an explicit 401 or 403 is the first: a
 * network error, a DNS failure, a timeout, a 5xx and a 404 are all things that
 * can be true of a server this desktop is perfectly entitled to talk to, and
 * treating any of them as a rejection means flaky wifi logs somebody out of
 * the call they are sitting in. When in doubt, keep the credential.
 */
export function isCredentialRejection(error: unknown): boolean {
  return error instanceof ControlRequestError && (error.status === 401 || error.status === 403);
}

/**
 * What went wrong, in the server's words where it gave any.
 *
 * The server explains its refusals in sentences meant for people - "ask the
 * current presenter to hand over the screen" - and throwing away that sentence
 * to show "HTTP 403 (forbidden)" turns an answer into a puzzle. The method and
 * path stay on the error for the log, not for the window.
 */
function describeFailure(method: string, path: string, status: number, body: unknown): string {
  const message = extractErrorMessage(body);
  if (message) return message;
  const code = extractErrorCode(body);
  return `${method} ${path} failed with HTTP ${status}${code ? ` (${code})` : ''}`;
}

/** The active shared desktop, as the control plane describes it. */
export interface ScreenShare {
  id: string;
  presenterMembershipId: string;
  presenterName?: string;
  sourceId?: string;
  allowDrawing: boolean;
  allowPointer: boolean;
  allowKeyboard: boolean;
}

export interface ShareRequestAck {
  layupId: string;
  shareId: string;
  askedByMembershipId: string;
  askedByName?: string;
}

const screenShareShape = isObject({
  id: isString,
  presenterMembershipId: isString,
  presenterName: optional(isString),
  sourceId: optional(isString),
  allowDrawing: isBoolean,
  allowPointer: isBoolean,
  allowKeyboard: isBoolean,
});

const shareRequestShape = isObject({
  layupId: isString,
  shareId: isString,
  askedByMembershipId: isString,
  askedByName: optional(isString),
});

export interface ControlClient {
  readonly baseUrl: string;
  /** Health check plus protocol compatibility, never throwing for the caller. */
  probe(): Promise<ControlConnectionState>;
  /** Versioned API call. Throws ControlRequestError on a non-2xx response. */
  apiGet<T>(path: string): Promise<T>;
  /** Versioned API command. Throws ControlRequestError on a non-2xx response. */
  apiPost<T>(path: string, body?: unknown): Promise<T>;
  /** Versioned API deletion. Throws ControlRequestError on a non-2xx response. */
  apiDelete<T>(path: string): Promise<T>;
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
  /**
   * The layup this user is in right now, if any.
   *
   * Asked at startup: without it, restarting the application looks like being
   * thrown out of the room you are standing in.
   */
  currentLayup(): Promise<MembershipResult | undefined>;
  /** Organisation-open layups (Happening Now). */
  openLayups(): Promise<OpenLayups>;
  /** ICE servers plus short-lived TURN credentials, and the relay policy. */
  turnCredentials(): Promise<IceConfiguration>;
  /** Mints an opaque invitation link for a layup you are in. */
  createLink(layupId: string): Promise<InvitationLink>;
  /**
   * Takes a layup's link out of circulation.
   *
   * The answer to "I pasted that in the wrong channel". Nobody new can join
   * with it from that moment; everybody already inside stays inside, because
   * revoking a link is not a way to remove a person.
   */
  revokeLink(layupId: string): Promise<void>;
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
  /** Starts sharing a screen, taking over from whoever was presenting. */
  startShare(layupId: string, sourceId: string): Promise<ScreenShare>;
  /** Stops your own share. The layup carries on without one. */
  stopShare(layupId: string): Promise<void>;
  /**
   * Asks the presenter of an advertised session for the screen.
   *
   * This exists only where taking it is refused. Everywhere else you simply
   * share, and the previous presenter is told (SPEC.md §7.2).
   */
  requestShare(layupId: string): Promise<ShareRequestAck>;
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
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    } else if (options.devUser) {
      headers[DEV_USER_HEADER] = options.devUser;
    }
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

    async startShare(layupId: string, sourceId: string): Promise<ScreenShare> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/layups/${encodeURIComponent(layupId)}/share`,
        { sourceId },
      );
      return screenShareShape(envelope.payload, 'screen.started');
    },

    async stopShare(layupId: string): Promise<void> {
      await this.apiPost(`/api/layups/${encodeURIComponent(layupId)}/share/stop`);
    },

    async requestShare(layupId: string): Promise<ShareRequestAck> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/layups/${encodeURIComponent(layupId)}/share/request`,
      );
      return shareRequestShape(envelope.payload, 'screen.share_request');
    },

    async currentLayup(): Promise<MembershipResult | undefined> {
      const envelope = await this.apiGet<{ payload?: unknown }>('/api/layups/current');
      const payload = (envelope.payload ?? {}) as { layup?: unknown };
      // No layup is an ordinary answer, and looks different from an empty one.
      if (!payload.layup) return undefined;
      return membershipResultShape(envelope.payload, 'layup.current');
    },

    async createLink(layupId: string): Promise<InvitationLink> {
      const envelope = await this.apiPost<{ payload?: unknown }>(
        `/api/layups/${encodeURIComponent(layupId)}/link`,
      );
      return invitationLinkShape(envelope.payload, 'layup.link');
    },

    async revokeLink(layupId: string): Promise<void> {
      await this.apiDelete(`/api/layups/${encodeURIComponent(layupId)}/link`);
    },

    async joinByLink(token: string): Promise<MembershipResult> {
      // In the body, never in the path. Caddy's access-log filter redacts
      // query strings but not paths, so a token in the URL would land in
      // cleartext in the log on every redemption - and a log is exactly the
      // place a working key to somebody's call must not be.
      const envelope = await this.apiPost<{ payload?: unknown }>('/api/links/join', { token });
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
          describeFailure('POST', path, response.status, parsed),
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
          describeFailure('GET', path, response.status, body),
          response.status,
          code,
        );
      }
      return (await response.json()) as T;
    },

    async apiDelete<T>(path: string): Promise<T> {
      const response = await withTimeout(`${baseUrl}${path}`, {
        method: 'DELETE',
        headers: apiHeaders(),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        const code = extractErrorCode(body);
        throw new ControlRequestError(
          describeFailure('DELETE', path, response.status, body),
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

function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const payload = (body as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const message = (payload as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() !== '' ? message : undefined;
}

function extractErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const payload = (body as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
