/**
 * The complete renderer -> main IPC surface.
 *
 * This map is the single source of truth: the preload bridge may only expose
 * channels declared here, and the main process may only answer channels
 * declared here. Both directions are validated, so neither a compromised
 * renderer nor a buggy handler can push unchecked data across the boundary.
 */
import {
  isEnum,
  isInteger,
  isObject,
  isString,
  isVoid,
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

export const ipcChannels = {
  'app:info': channel(isVoid, appInfoResponse),
} as const;

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
