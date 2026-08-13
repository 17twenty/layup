import { describe, expect, it, vi } from 'vitest';
import { createLayupApi } from './api';
import { ValidationError } from '@layup/protocol';

describe('preload bridge surface', () => {
  it('exposes only the declared API and nothing from Node or Electron', () => {
    const api = createLayupApi(async () => ({}));
    expect(Object.keys(api).sort()).toEqual(['app', 'control', 'identity', 'protocolVersion']);
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

  it('sends no payload on a no-argument channel', async () => {
    const invoker = vi.fn(async () => ({ appVersion: '1', protocolVersion: 1, platform: 'linux' }));
    const api = createLayupApi(invoker);
    await api.app.info();
    expect(invoker).toHaveBeenCalledWith('app:info', undefined);
  });
});
