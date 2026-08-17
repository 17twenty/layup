/**
 * The complete renderer -> main IPC surface.
 *
 * This map is the single source of truth: the preload bridge may only expose
 * channels declared here, and the main process may only answer channels
 * declared here. Both directions are validated, so neither a compromised
 * renderer nor a buggy handler can push unchecked data across the boundary.
 */
import {
  ValidationError,
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
  /** The shared desktop, when there is one (see control-client's layupShape). */
  activeShare: optional(
    isObject({
      id: isString,
      presenterMembershipId: isString,
      presenterName: optional(isString),
      sourceId: optional(isString),
      allowDrawing: isBoolean,
      allowPointer: isBoolean,
      allowKeyboard: isBoolean,
    }),
  ),
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

/**
 * A relayed WebRTC signalling message (SPEC.md §10.2).
 *
 * The control plane never sees media; it forwards these between peers. The
 * shape is checked here so a malformed one is refused at the boundary rather
 * than inside the peer connection.
 */
export const signalMessageShape = isObject({
  layupId: isString,
  toMembershipId: isString,
  fromMembershipId: optional(isString),
  fromUserId: optional(isString),
  sdp: optional(isString),
  candidate: optional(isString),
  sdpMid: optional(isString),
  sdpMLineIndex: optional(isInteger({ min: 0 })),
  reason: optional(isString),
});
export type SignalEnvelope = ReturnType<typeof signalEnvelope>;

export const signalEnvelope = isObject({
  type: isString,
  message: signalMessageShape,
});

/**
 * A payload this side deliberately does not interpret.
 *
 * Remote-input messages pass through the renderer on their way from a peer to
 * the main process, which is the only place entitled to judge them. Naming
 * their fields here would put the input vocabulary in the unprivileged surface
 * for no benefit: the guard decodes and validates them, and refuses anything it
 * does not recognise (ADR-0006).
 */
const isOpaquePayload: Validator<Record<string, unknown>> = (value, path = '') => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(path, 'expected object');
  }
  return value as Record<string, unknown>;
};

/** The shared desktop as the renderer sees it, plus any transition notice. */
export const shareStateResponse = isObject({
  share: optional(
    isObject({
      id: isString,
      presenterMembershipId: isString,
      presenterName: optional(isString),
      sourceId: optional(isString),
      allowDrawing: isBoolean,
      allowPointer: isBoolean,
      allowKeyboard: isBoolean,
    }),
  ),
  notice: optional(
    isObject({
      kind: isEnum(['takeover', 'ask-to-share'] as const),
      text: isString,
      membershipId: optional(isString),
      atMs: isFiniteNumber,
    }),
  ),
});
export type ShareStateResponse = ReturnType<typeof shareStateResponse>;

const controlScope = isEnum(['pointer', 'keyboard'] as const);

/** What this machine is sharing, and who has been stopped by name. */
export const remoteControlStateResponse = isObject({
  allowed: isObject({ pointer: isBoolean, keyboard: isBoolean }),
  stopped: isArrayOf(
    isObject({ membershipId: isString, scopes: isArrayOf(controlScope, { max: 2 }) }),
    { max: 64 },
  ),
  anyoneHasControl: isBoolean,
  /** The emergency-revoke accelerator, when the OS gave us one. */
  shortcut: optional(isString),
});
export type RemoteControlStateResponse = ReturnType<typeof remoteControlStateResponse>;

/**
 * Which shape the window should take (see main/window-modes.ts).
 *
 * A name, never bounds. The renderer knows things main cannot - whether the
 * picker is open, whether a peer's video has actually arrived - so it chooses
 * the mode; main decides what that means in pixels. Handing the renderer real
 * coordinates for an always-on-top window would be handing it a way to place
 * content precisely over OS chrome.
 */
/**
 * Which server this desktop belongs to, as far as the config on disk says.
 *
 * The token never appears here. The renderer needs to know whether a server
 * has been added and what to call it - never how to prove it is us.
 */
export const serverStateResponse = isObject({
  configured: isBoolean,
  serverUrl: optional(isString),
  displayName: optional(isString),
});
export type ServerStateResponse = ReturnType<typeof serverStateResponse>;

/** What somebody types on the first-run screen: an address, a code, a name. */
export const addServerRequest = isObject({
  serverUrl: isString,
  code: isString,
  displayName: isString,
});
export type AddServerRequest = ReturnType<typeof addServerRequest>;

/**
 * The answer to "add this server".
 *
 * A refusal carries the server's own sentence, because "that join code is not
 * valid for this server" sends somebody back to the code, and a generic
 * failure sends them to us.
 */
export const addServerResponse = isObject({
  ok: isBoolean,
  message: optional(isString),
});
export type AddServerResponse = ReturnType<typeof addServerResponse>;

export const uiModeShape = isObject({
  mode: isEnum(['home', 'compact', 'picker', 'viewer'] as const),
});
export type UiModeResponse = ReturnType<typeof uiModeShape>;

export const ipcChannels = {
  'app:info': channel(isVoid, appInfoResponse),
  'server:state': channel(isVoid, serverStateResponse),
  'server:add': channel(addServerRequest, addServerResponse),
  'server:forget': channel(isVoid, serverStateResponse),
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
  'signal:send': channel(signalEnvelope, isBoolean),
  'share:current': channel(isVoid, shareStateResponse),
  'share:start': channel(isObject({ sourceId: isString }), shareStateResponse),
  'share:stop': channel(isVoid, shareStateResponse),
  'share:ask': channel(isVoid, shareStateResponse),
  'control:state': channel(isVoid, remoteControlStateResponse),
  'control:allow': channel(
    isObject({ scope: controlScope, allowed: isBoolean }),
    remoteControlStateResponse,
  ),
  'control:stop': channel(isObject({ membershipId: isString }), remoteControlStateResponse),
  'control:resume': channel(isObject({ membershipId: isString }), remoteControlStateResponse),
  'control:stopAll': channel(isVoid, remoteControlStateResponse),
  /**
   * Offers one message a peer sent us. The renderer carries it; the main
   * process decides whether it becomes an OS event, and answers with what
   * happened - never with anything about the message itself.
   */
  'input:offer': channel(
    isObject({ fromMembershipId: isString, message: isOpaquePayload }),
    isObject({ injected: isBoolean, reason: optional(isString) }),
  ),
  'ui:mode': channel(uiModeShape, uiModeShape),
} as const;

/**
 * Main -> renderer push events.
 *
 * Payloads are validated on arrival exactly like request/response channels: a
 * privileged process bug must not become unchecked renderer state.
 */
export const ipcEvents = {
  'realtime:state': realtimeStateResponse,
  /** The configured server changed: added, or forgotten. */
  'server:changed': serverStateResponse,
  'signal:received': signalEnvelope,
  'share:changed': shareStateResponse,
  'control:changed': remoteControlStateResponse,
  /** A control decision the main process wants sent to the peers. */
  'control:send': isOpaquePayload,
  /** The mode actually applied, when it differs from what was asked for. */
  'ui:mode': uiModeShape,
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
