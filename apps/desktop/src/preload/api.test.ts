import { describe, expect, it, vi } from 'vitest';
import { createLayupApi } from './api';
import { ValidationError } from '@layup/protocol';

describe('preload bridge surface', () => {
  it('exposes only the declared API and nothing from Node or Electron', () => {
    const api = createLayupApi(async () => ({}));
    expect(Object.keys(api).sort()).toEqual(['app', 'control', 'identity', 'protocolVersion', 'realtime']);
    expect(Object.keys(api.app)).toEqual(['info']);
    const serialised = JSON.stringify(api, (_key, value) =>
      typeof value === 'function' ? '[fn]' : value,
    );
    expect(serialised).not.toMatch(/require|process|ipcRenderer|__dirname/);
  });

  it('validates the response coming back from the main process', async () => {
    const api = createLayupApi(async () => ({ appVersion: '1', protocolVersion: 1, platform: 'darwin' }));
    await expect(api.app.info()).resolves.toEqual({
      appVersion: '1',
      protocolVersion: 1,
      platform: 'darwin',
    });
  });

  it('rejects a malformed response rather than handing it to the renderer', async () => {
    const api = createLayupApi(async () => ({ appVersion: '1', protocolVersion: 1, platform: 'beos' }));
    await expect(api.app.info()).rejects.toThrow(ValidationError);
  });

  it('validates pushed events and drops malformed ones', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const api = createLayupApi(
      async () => ({}),
      (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    );

    const seen: unknown[] = [];
    const unsubscribe = api.realtime.onState((state) => seen.push(state));

    listeners.get('realtime:state')?.({ status: 'connected', attempt: 0 });
    listeners.get('realtime:state')?.({ status: 'nonsense', attempt: 0 });
    listeners.get('realtime:state')?.('not an object');
    expect(seen).toEqual([{ status: 'connected', attempt: 0 }]);

    unsubscribe();
    expect(listeners.has('realtime:state')).toBe(false);
  });

  it('sends no payload on a no-argument channel', async () => {
    const invoker = vi.fn(async () => ({ appVersion: '1', protocolVersion: 1, platform: 'linux' }));
    const api = createLayupApi(invoker);
    await api.app.info();
    expect(invoker).toHaveBeenCalledWith('app:info', undefined);
  });
});
