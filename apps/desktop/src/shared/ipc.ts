/**
 * The complete renderer -> main IPC surface.
 *
 * This map is the single source of truth: the preload bridge may only expose
 * channels declared here, and the main process may only answer channels
 * declared here. Both directions are validated, so neither a compromised
 * renderer nor a buggy handler can push unchecked data across the boundary.
 */
import {
  isArrayOf,
  isBoolean,
  isEnum,
  isFiniteNumber,
  isInteger,
  isObject,
  isString,
  isVoid,
  optional,
  type Validator,
} from '@layup/protocol';

export interface ChannelSpec<Req, Res> {
  request: Validator<Req>;
  response: Validator<Res>;
}

function channel<Req, Res>(request: Validator<Req>, response: Validator<Res>): ChannelSpec<Req, Res> {
  return { request, response };
}

export const appInfoResponse = isObject({
  appVersion: isString,
  protocolVersion: isInteger({ min: 1 }),
  platform: isEnum(['darwin', 'win32', 'linux'] as const),
});
export type AppInfo = ReturnType<typeof appInfoResponse>;

/** Mirrors ControlConnectionState in core/control-client.ts. */
export const controlStatusResponse = isObject({
  status: isEnum(['connected', 'unreachable', 'incompatible'] as const),
  baseUrl: isString,
  clientProtocolVersion: isInteger({ min: 1 }),
  serverProtocolVersion: optional(isInteger({ min: 1 })),
  serverVersion: optional(isString),
  environment: optional(isString),
  latencyMs: optional(isFiniteNumber),
  detail: optional(isString),
  checkedAtMs: isFiniteNumber,
});
export type ControlStatusResponse = ReturnType<typeof controlStatusResponse>;

/** Mirrors IdentityState in main/control.ts. */
export const identityResponse = isObject({
  devUser: isString,
  resolved: isBoolean,
  userId: optional(isString),
  displayName: optional(isString),
  organisationId: optional(isString),
  organisationName: optional(isString),
  detail: optional(isString),
});
export type IdentityResponse = ReturnType<typeof identityResponse>;

/** Mirrors RealtimeState in core/realtime-client.ts. */
export const realtimeStateResponse = isObject({
  status: isEnum(['idle', 'connecting', 'connected', 'reconnecting', 'stopped'] as const),
  connectionId: optional(isString),
  userId: optional(isString),
  organisationId: optional(isString),
  attempt: isInteger({ min: 0 }),
  lastError: optional(isString),
  lastMessageAtMs: optional(isFiniteNumber),
});
export type RealtimeStateResponse = ReturnType<typeof realtimeStateResponse>;

/** Mirrors Person in core/people-store.ts. */
const personShape = isObject({
  userId: isString,
  displayName: isString,
  statusMessage: optional(isString),
  personal: isEnum(['AVAILABLE', 'AWAY', 'DND', 'OFFLINE'] as const),
  activity: isEnum([
    'NONE',
    'IN_PRIVATE_LAYUP',
    'IN_OPEN_LAYUP',
    'INVITING_YOU',
    'WAITING_FOR_YOU',
  ] as const),
  layupId: optional(isString),
  layupTitle: optional(isString),
  participantCount: optional(isInteger({ min: 0 })),
});

export const peopleResponse = isObject({ people: isArrayOf(personShape, { max: 500 }) });
export type PeopleResponse = ReturnType<typeof peopleResponse>;

const participantShape = isObject({
  membershipId: isString,
  userId: isString,
  displayName: isString,
  joinedAt: isString,
  leftAt: optional(isString),
  isCreatorMembership: isBoolean,
});

const layupShape = isObject({
  id: isString,
  organisationId: isString,
  title: optional(isString),
  visibility: isEnum(['PRIVATE', 'ORGANISATION', 'LINK'] as const),
  active: isBoolean,
  createdAt: isString,
  endedAt: optional(isString),
  hasCreatorAuthority: isBoolean,
  creatorMembershipId: optional(isString),
  participants: isArrayOf(participantShape, { max: 200 }),
});

/** Mirrors LayupState in main/layups.ts. */
export const layupStateResponse = isObject({
  layup: optional(layupShape),
  membershipId: optional(isString),
  youAreCreatorMembership: isBoolean,
  media: optional(
    isObject({
      camera: isBoolean,
      microphone: isBoolean,
      participantCount: isInteger({ min: 0 }),
      mutedByThreshold: isBoolean,
    }),
  ),
});
export type LayupStateResponse = ReturnType<typeof layupStateResponse>;

export const createLayupRequest = isObject({
  title: optional(isString),
  visibility: optional(isEnum(['PRIVATE', 'ORGANISATION', 'LINK'] as const)),
});

export const joinLayupRequest = isObject({ layupId: isString });

const joinRequestShape = isObject({
  id: isString,
  type: isEnum(['INVITE_USER_TO_NEW_LAYUP', 'INVITE_USER_TO_LAYUP', 'KNOCK_TO_JOIN'] as const),
  state: isEnum(['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'] as const),
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

export const requestsResponse = isObject({
  incoming: isArrayOf(joinRequestShape, { max: 100 }),
  outgoing: isArrayOf(joinRequestShape, { max: 100 }),
});
export type RequestsResponse = ReturnType<typeof requestsResponse>;

export const inviteRequest = isObject({
  toUserId: isString,
  note: optional(isString),
  /** When present, invites into this existing layup instead of a new one. */
  layupId: optional(isString),
});
export const requestIdRequest = isObject({ requestId: isString });

/** One organisation-open layup on the Happening Now surface. */
const openLayupShape = isObject({
  id: isString,
  title: optional(isString),
  participantCount: isInteger({ min: 0 }),
  participants: isArrayOf(isString, { max: 200 }),
  presenterName: optional(isString),
  canJoin: isBoolean,
  youAreInIt: isBoolean,
});

export const openLayupsResponse = isObject({
  layups: isArrayOf(openLayupShape, { max: 200 }),
});
export type OpenLayupsResponse = ReturnType<typeof openLayupsResponse>;

const captureSourceShape = isObject({
  id: isString,
  name: isString,
  kind: isEnum(['screen', 'window'] as const),
  thumbnailDataUrl: optional(isString),
  displayId: optional(isString),
});

export const captureSourcesResponse = isObject({
  sources: isArrayOf(captureSourceShape, { max: 200 }),
});
export type CaptureSourcesResponse = ReturnType<typeof captureSourcesResponse>;

export const capturePermissionResponse = isObject({
  status: isEnum(['granted', 'denied', 'restricted', 'not-determined', 'not-required', 'unknown'] as const),
  canCapture: isBoolean,
  guidance: isString,
  canOpenSettings: isBoolean,
  platform: isString,
});
export type CapturePermissionResponse = ReturnType<typeof capturePermissionResponse>;

const iceServerShape = isObject({
  urls: isArrayOf(isString, { max: 20 }),
  username: optional(isString),
  credential: optional(isString),
});

export const iceConfigResponse = isObject({
  iceServers: isArrayOf(iceServerShape, { max: 20 }),
  expiresAt: isString,
  forceRelay: isBoolean,
  forcedBy: optional(isEnum(['policy', 'local'] as const)),
});
export type IceConfigResponse = ReturnType<typeof iceConfigResponse>;

/**
 * Remote-control capability, as reported by the native helper.
 *
 * This is deliberately a *description*: what is possible and why not, never a
 * handle, socket or command surface (ADR-0006, SPEC.md §13.2).
 */
export const remoteControlResponse = isObject({
  helperRunning: isBoolean,
  pointer: isBoolean,
  keyboard: isBoolean,
  platform: optional(isString),
  detail: optional(isString),
});
export type RemoteControlResponse = ReturnType<typeof remoteControlResponse>;

export const ipcChannels = {
  'app:info': channel(isVoid, appInfoResponse),
  'capture:sources': channel(isVoid, captureSourcesResponse),
  'capture:permission': channel(isVoid, capturePermissionResponse),
  'capture:openSettings': channel(isVoid, isBoolean),
  'control:status': channel(isVoid, controlStatusResponse),
  'control:remote': channel(isVoid, remoteControlResponse),
  'identity:current': channel(isVoid, identityResponse),
  'realtime:status': channel(isVoid, realtimeStateResponse),
  'people:list': channel(isVoid, peopleResponse),
  'layup:current': channel(isVoid, layupStateResponse),
  'layup:create': channel(createLayupRequest, layupStateResponse),
  'layup:join': channel(joinLayupRequest, layupStateResponse),
  'layup:leave': channel(isVoid, layupStateResponse),
  'layup:open': channel(isVoid, openLayupsResponse),
  'ice:config': channel(isVoid, iceConfigResponse),
  'layup:link': channel(isVoid, isObject({ token: isString, expiresAt: isString })),
  'layup:joinLink': channel(isObject({ token: isString }), layupStateResponse),
  'requests:list': channel(isVoid, requestsResponse),
  'requests:invite': channel(inviteRequest, joinRequestShape),
  'requests:knock': channel(isObject({ toUserId: isString }), joinRequestShape),
  'requests:accept': channel(requestIdRequest, isVoid),
  'requests:decline': channel(requestIdRequest, isVoid),
  'requests:cancel': channel(requestIdRequest, isVoid),
} as const;

/**
 * Main -> renderer push events.
 *
 * Payloads are validated on arrival exactly like request/response channels: a
 * privileged process bug must not become unchecked renderer state.
 */
export const ipcEvents = {
  'realtime:state': realtimeStateResponse,
  'people:changed': peopleResponse,
  'layup:changed': layupStateResponse,
  'requests:changed': requestsResponse,
} as const;

export type EventName = keyof typeof ipcEvents;
export type EventPayload<E extends EventName> =
  (typeof ipcEvents)[E] extends Validator<infer P> ? P : never;

export type IpcChannels = typeof ipcChannels;
export type ChannelName = keyof IpcChannels;

export type RequestOf<C extends ChannelName> =
  IpcChannels[C]['request'] extends Validator<infer Req> ? Req : never;
export type ResponseOf<C extends ChannelName> =
  IpcChannels[C]['response'] extends Validator<infer Res> ? Res : never;

export const channelNames = Object.keys(ipcChannels) as ChannelName[];

export function isKnownChannel(name: string): name is ChannelName {
  return Object.prototype.hasOwnProperty.call(ipcChannels, name);
}
