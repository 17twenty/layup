import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerIpcHandlers, type HandleTarget, type Handlers } from './ipc';
import { ValidationError } from '@layup/protocol';

function fakeIpcMain() {
  const registered = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const target: HandleTarget = {
    handle: (channel, listener) => void registered.set(channel, listener),
  };
  const invoke = (channel: string, ...args: unknown[]) => {
    const listener = registered.get(channel);
    if (!listener) throw new Error(`no handler for ${channel}`);
    return listener({} as IpcMainInvokeEvent, ...args);
  };
  return { target, registered, invoke };
}

const controlState = {
  status: 'connected' as const,
  baseUrl: 'http://127.0.0.1:8787',
  clientProtocolVersion: 1,
  checkedAtMs: 1,
};

const idleControl = {
  allowed: { pointer: false, keyboard: false },
  stopped: [],
  anyoneHasControl: false,
};

const goodHandlers: Handlers = {
  'app:info': () => ({ appVersion: '0.1.0', protocolVersion: 1, platform: 'darwin' }),
  'server:state': () => ({ configured: false }),
  'server:add': () => ({ ok: false, message: 'no server in this fixture' }),
  'server:forget': () => ({ configured: false }),
  'capture:sources': () => ({ sources: [] }),
  'capture:permission': () => ({
    status: 'granted' as const,
    canCapture: true,
    guidance: '',
    canOpenSettings: true,
    platform: 'darwin',
  }),
  'capture:openSettings': () => true,
  'permissions:all': () => {
    const granted = {
      status: 'granted' as const,
      ok: true,
      guidance: '',
      canOpenSettings: true,
      canRequest: false,
    };
    return {
      camera: granted,
      microphone: granted,
      screen: granted,
      accessibility: granted,
    };
  },
  'permissions:request': () => true,
  'permissions:openSettings': () => true,
  'control:status': () => controlState,
  'control:remote': () => ({ helperRunning: false, pointer: false, keyboard: false }),
  'identity:current': () => ({ devUser: 'nick', resolved: false }),
  'realtime:status': () => ({ status: 'idle' as const, attempt: 0 }),
  'people:list': () => ({ people: [] }),
  'layup:current': () => ({ youAreCreatorMembership: false }),
  'layup:create': () => ({ youAreCreatorMembership: false }),
  'layup:join': () => ({ youAreCreatorMembership: false }),
  'layup:leave': () => ({ youAreCreatorMembership: false }),
  'layup:open': () => ({ layups: [] }),
  'ice:config': () => ({ iceServers: [], expiresAt: '2026-08-14T09:00:00Z', forceRelay: false }),
  'layup:link': () => ({ url: 'https://layup.blah.au/j/#tok' }),
  'layup:revokeLink': () => undefined,
  'layup:joinLink': () => ({ youAreCreatorMembership: false }),
  'requests:list': () => ({ incoming: [], outgoing: [] }),
  'requests:invite': () => ({
    id: 'jrq_devaaaaab',
    type: 'INVITE_USER_TO_NEW_LAYUP' as const,
    state: 'PENDING' as const,
    fromUserId: 'usr_devnickx',
    fromName: 'Nick',
    createdAt: '2026-08-13T09:00:00Z',
    expiresAt: '2026-08-13T09:01:00Z',
  }),
  'requests:knock': () => ({
    id: 'jrq_devaaaaac',
    type: 'KNOCK_TO_JOIN' as const,
    state: 'PENDING' as const,
    fromUserId: 'usr_devkarlx',
    fromName: 'Karl',
    createdAt: '2026-08-13T09:00:00Z',
    expiresAt: '2026-08-13T09:01:00Z',
  }),
  'requests:accept': () => undefined,
  'requests:decline': () => undefined,
  'requests:cancel': () => undefined,
  'signal:send': () => true,
  'share:current': () => ({}),
  'share:start': () => ({}),
  'share:stop': () => ({}),
  'share:ask': () => ({}),
  'control:state': () => idleControl,
  'control:allow': () => idleControl,
  'control:stop': () => idleControl,
  'control:resume': () => idleControl,
  'control:stopAll': () => idleControl,
  'input:offer': () => ({ injected: false, reason: 'stopped' }),
  'ui:mode': () => ({ mode: 'compact' as const }),
  'update:state': () => ({ status: 'idle' as const }),
  'update:install': () => false,
  'preferences:get': () => ({ soundsMuted: false }),
  'preferences:set': (input) => input,
};

describe('main IPC boundary', () => {
  it('answers a valid request with a validated response', async () => {
    const ipc = fakeIpcMain();
    registerIpcHandlers(ipc.target, goodHandlers);
    await expect(ipc.invoke('app:info')).resolves.toEqual({
      appVersion: '0.1.0',
      protocolVersion: 1,
      platform: 'darwin',
    });
  });

  it('registers exactly the declared channels', () => {
    const ipc = fakeIpcMain();
    registerIpcHandlers(ipc.target, goodHandlers);
    expect([...ipc.registered.keys()]).toEqual([
      'app:info',
      'server:state',
      'server:add',
      'server:forget',
      'capture:sources',
      'capture:permission',
      'capture:openSettings',
      'permissions:all',
      'permissions:request',
      'permissions:openSettings',
      'control:status',
      'control:remote',
      'identity:current',
      'realtime:status',
      'people:list',
      'layup:current',
      'layup:create',
      'layup:join',
      'layup:leave',
      'layup:open',
      'ice:config',
      'layup:link',
      'layup:revokeLink',
      'layup:joinLink',
      'requests:list',
      'requests:invite',
      'requests:knock',
      'requests:accept',
      'requests:decline',
      'requests:cancel',
      'signal:send',
      'share:current',
      'share:start',
      'share:stop',
      'share:ask',
      'control:state',
      'control:allow',
      'control:stop',
      'control:resume',
      'control:stopAll',
      'input:offer',
      'ui:mode',
      'update:state',
      'update:install',
      'preferences:get',
      'preferences:set',
    ]);
  });

  it('rejects an unexpected payload before the handler runs', async () => {
    const ipc = fakeIpcMain();
    const handler = vi.fn(goodHandlers['app:info']);
    const onRejected = vi.fn();
    registerIpcHandlers(ipc.target, { ...goodHandlers, 'app:info': handler }, { onRejected });

    await expect(ipc.invoke('app:info', { sneaky: true })).rejects.toThrow(ValidationError);
    expect(handler).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith('app:info', expect.any(ValidationError));
  });

  it('rejects extra positional arguments', async () => {
    const ipc = fakeIpcMain();
    const handler = vi.fn(goodHandlers['app:info']);
    registerIpcHandlers(ipc.target, { ...goodHandlers, 'app:info': handler });
    await expect(ipc.invoke('app:info', undefined, 'extra')).rejects.toThrow(ValidationError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses to return a response the renderer was not promised', async () => {
    const ipc = fakeIpcMain();
    registerIpcHandlers(ipc.target, {
      ...goodHandlers,
      'app:info': () =>
        ({ appVersion: '0.1.0', protocolVersion: 1, platform: 'darwin', secret: 'token' }) as never,
    });
    await expect(ipc.invoke('app:info')).rejects.toThrow(ValidationError);
  });
});
