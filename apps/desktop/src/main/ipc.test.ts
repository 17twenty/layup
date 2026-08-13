import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerIpcHandlers, type HandleTarget, type Handlers } from './ipc';
import { ValidationError } from '../shared/validate';

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

const goodHandlers: Handlers = {
  'app:info': () => ({ appVersion: '0.1.0', protocolVersion: 1, platform: 'darwin' }),
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
    expect([...ipc.registered.keys()]).toEqual(['app:info']);
  });

  it('rejects an unexpected payload before the handler runs', async () => {
    const ipc = fakeIpcMain();
    const handler = vi.fn(goodHandlers['app:info']);
    const onRejected = vi.fn();
    registerIpcHandlers(ipc.target, { 'app:info': handler }, { onRejected });

    await expect(ipc.invoke('app:info', { sneaky: true })).rejects.toThrow(ValidationError);
    expect(handler).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith('app:info', expect.any(ValidationError));
  });

  it('rejects extra positional arguments', async () => {
    const ipc = fakeIpcMain();
    const handler = vi.fn(goodHandlers['app:info']);
    registerIpcHandlers(ipc.target, { 'app:info': handler });
    await expect(ipc.invoke('app:info', undefined, 'extra')).rejects.toThrow(ValidationError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses to return a response the renderer was not promised', async () => {
    const ipc = fakeIpcMain();
    registerIpcHandlers(ipc.target, {
      'app:info': () =>
        ({ appVersion: '0.1.0', protocolVersion: 1, platform: 'darwin', secret: 'token' }) as never,
    });
    await expect(ipc.invoke('app:info')).rejects.toThrow(ValidationError);
  });
});
