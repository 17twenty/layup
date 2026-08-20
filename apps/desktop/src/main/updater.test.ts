import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdater, type AutoUpdaterLike, type UpdateState } from './updater';
import { createLogger } from './logging';

const log = createLogger({ level: 'error', write: () => {} });

/** A stand-in for electron-updater: events are fired by the test, not a feed. */
function fakeAutoUpdater() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const fake = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => ({})),
    quitAndInstall: vi.fn(),
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return fake;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return fake as AutoUpdaterLike & { emit(event: string, ...args: unknown[]): void } & {
    checkForUpdates: ReturnType<typeof vi.fn>;
    quitAndInstall: ReturnType<typeof vi.fn>;
  };
}

function build(overrides: { isBusy?: () => boolean } = {}) {
  const autoUpdater = fakeAutoUpdater();
  const changes: UpdateState[] = [];
  const updater = createUpdater({
    log,
    autoUpdater,
    isBusy: overrides.isBusy ?? (() => false),
    onChanged: (state) => changes.push(state),
  });
  return { autoUpdater, updater, changes };
}

describe('updating without interrupting anybody', () => {
  beforeEach(() => vi.useRealTimers());

  it('checks on start and reports an available version', async () => {
    const { autoUpdater, updater, changes } = build();

    updater.start();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.state().status).toBe('checking');

    autoUpdater.emit('update-available', { version: '0.3.0' });

    expect(updater.state()).toEqual({ status: 'available', version: '0.3.0' });
    expect(changes.map((state) => state.status)).toContain('available');
    updater.dispose();
  });

  it('downloads and then says it is ready, naming the version', () => {
    const { autoUpdater, updater } = build();
    updater.start();

    autoUpdater.emit('update-available', { version: '0.3.0' });
    autoUpdater.emit('download-progress', { percent: 42 });
    expect(updater.state().status).toBe('downloading');

    autoUpdater.emit('update-downloaded', { version: '0.3.0' });
    expect(updater.state()).toEqual({ status: 'ready', version: '0.3.0' });
    updater.dispose();
  });

  it('never restarts out from under a live layup', () => {
    const { autoUpdater, updater } = build({ isBusy: () => true });
    updater.start();
    autoUpdater.emit('update-downloaded', { version: '0.3.0' });

    expect(updater.state().status).toBe('ready');
    expect(updater.quitAndInstall()).toBe(false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    updater.dispose();
  });

  it('installs once the layup ends and the person asks', () => {
    let busy = true;
    const { autoUpdater, updater } = build({ isBusy: () => busy });
    updater.start();
    autoUpdater.emit('update-downloaded', { version: '0.3.0' });

    expect(updater.quitAndInstall()).toBe(false);
    busy = false;
    expect(updater.quitAndInstall()).toBe(true);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    updater.dispose();
  });

  it('installs nothing when nothing is ready, however hard it is asked', () => {
    const { autoUpdater, updater } = build();
    updater.start();

    expect(updater.quitAndInstall()).toBe(false);
    autoUpdater.emit('update-available', { version: '0.3.0' });
    expect(updater.quitAndInstall()).toBe(false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    updater.dispose();
  });

  it('says an unreachable feed out loud instead of crashing', () => {
    const { autoUpdater, updater } = build();
    updater.start();

    autoUpdater.emit('error', new Error('getaddrinfo ENOTFOUND layup.blah.au'));

    const state = updater.state();
    expect(state.status).toBe('error');
    expect(state.message).toMatch(/layup\.blah\.au/);
    updater.dispose();
  });

  it('does not let a rejected check block startup', async () => {
    const { autoUpdater, updater } = build();
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('403 Forbidden'));

    // start() returns; the rejection is absorbed, not thrown at the caller.
    expect(() => updater.start()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(updater.state().status).toBe('error');
    expect(updater.state().message).toMatch(/403 Forbidden/);
    updater.dispose();
  });

  it('reports an error with a readable sentence even when the feed throws a nothing', () => {
    const { autoUpdater, updater } = build();
    updater.start();

    autoUpdater.emit('error', undefined);

    expect(updater.state().message).toBeTruthy();
    expect(updater.state().message).not.toMatch(/undefined/);
    updater.dispose();
  });

  it('goes back to idle when the feed has nothing newer', () => {
    const { autoUpdater, updater } = build();
    updater.start();

    autoUpdater.emit('update-not-available', { version: '0.2.0' });

    expect(updater.state()).toEqual({ status: 'idle' });
    updater.dispose();
  });

  it('downloads by itself and installs on quit, but decides restarts itself', () => {
    const { autoUpdater, updater } = build();
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    updater.dispose();
  });

  it('keeps looking on an interval, and stops when disposed', async () => {
    vi.useFakeTimers();
    const { autoUpdater, updater } = build();

    updater.start();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

    updater.dispose();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('never re-enters a check that is already in flight', () => {
    const { autoUpdater, updater } = build();
    updater.start();
    void updater.check();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.dispose();
  });
});
