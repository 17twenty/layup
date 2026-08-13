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
export const personShape = isObject({
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

export const participantShape = isObject({
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
});
export type LayupStateResponse = ReturnType<typeof layupStateResponse>;

export const createLayupRequest = isObject({
  title: optional(isString),
  visibility: optional(isEnum(['PRIVATE', 'ORGANISATION', 'LINK'] as const)),
});

export const joinLayupRequest = isObject({ layupId: isString });

export const ipcChannels = {
  'app:info': channel(isVoid, appInfoResponse),
  'control:status': channel(isVoid, controlStatusResponse),
  'identity:current': channel(isVoid, identityResponse),
  'realtime:status': channel(isVoid, realtimeStateResponse),
  'people:list': channel(isVoid, peopleResponse),
  'layup:current': channel(isVoid, layupStateResponse),
  'layup:create': channel(createLayupRequest, layupStateResponse),
  'layup:join': channel(joinLayupRequest, layupStateResponse),
  'layup:leave': channel(isVoid, layupStateResponse),
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
} as const;

export type EventName = keyof typeof ipcEvents;
export type EventPayload<E extends EventName> =
  (typeof ipcEvents)[E] extends Validator<infer P> ? P : never;

export const eventNames = Object.keys(ipcEvents) as EventName[];

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
