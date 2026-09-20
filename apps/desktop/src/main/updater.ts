import type { Logger } from './logging';

/**
 * Keeping the desktop current without ever interrupting a call.
 *
 * 0.2.0 is meant to be the last build anybody installs by hand, so this checks
 * a generic feed on `layup.blah.au`, downloads quietly in the background, and
 * then *waits*. Restarting somebody mid-layup to apply a fix is a worse bug
 * than the one being fixed, so `isBusy()` gates the only path to a restart and
 * the affordance is a line in the footer, never a modal over a screen share.
 *
 * The autoUpdater is injected rather than imported so this is testable without
 * a packaged app, a feed, or a network.
 */

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** The version being offered, once the feed has named one. */
  version?: string;
  /** Why it failed, in a sentence somebody can act on. */
  message?: string;
}

/** The slice of electron-updater's `autoUpdater` this depends on. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterOptions {
  log: Logger;
  autoUpdater: AutoUpdaterLike;
  /** True while a layup is live. Nothing restarts this desktop while it is. */
  isBusy: () => boolean;
  onChanged?: (state: UpdateState) => void;
  /** How often to look after the first check. Hourly is plenty. */
  intervalMs?: number;
}

export interface Updater {
  /** Checks now, then keeps checking on the interval. */
  start(): void;
  /** Asks the feed once. Never throws: a dead feed is a state, not a crash. */
  check(): Promise<UpdateState>;
  state(): UpdateState;
  /**
   * Restarts into the new version, if there is one and nobody is mid-layup.
   * Returns whether it actually did, so the caller is never lied to.
   */
  quitAndInstall(): boolean;
  dispose(): void;
}

const HOURLY = 60 * 60 * 1000;

/** Whatever the feed threw, turned into something a person can read. */
function readable(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return 'the update feed could not be reached';
}

/** The version an electron-updater event carries, when it carries one. */
function versionOf(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const version = (info as { version?: unknown }).version;
  return typeof version === 'string' && version !== '' ? version : undefined;
}

export function createUpdater(options: UpdaterOptions): Updater {
  const { log, autoUpdater, isBusy } = options;
  const intervalMs = options.intervalMs ?? HOURLY;

  let state: UpdateState = { status: 'idle' };
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let disposed = false;

  const publish = (next: UpdateState) => {
    state = next;
    options.onChanged?.(next);
  };

  // Downloading is free and silent; it is *installing* that interrupts people,
  // and that stays behind isBusy() and a deliberate click. Installing on quit
  // is safe by definition - the person already chose to stop.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => publish({ status: 'checking' }));

  autoUpdater.on('update-available', ((info: unknown) => {
    const version = versionOf(info);
    log.info('update available', { version: version ?? 'unnamed' });
    publish({ status: 'available', ...(version ? { version } : {}) });
  }) as (...args: never[]) => void);

  autoUpdater.on('update-not-available', () => publish({ status: 'idle' }));

  autoUpdater.on('download-progress', ((progress: unknown) => {
    const percent = typeof (progress as { percent?: unknown })?.percent === 'number'
      ? Math.round((progress as { percent: number }).percent)
      : undefined;
    publish({
      status: 'downloading',
      ...(state.version ? { version: state.version } : {}),
      ...(percent === undefined ? {} : { message: `${percent}%` }),
    });
  }) as (...args: never[]) => void);

  autoUpdater.on('update-downloaded', ((info: unknown) => {
    const version = versionOf(info) ?? state.version;
    log.info('update ready to install', { version: version ?? 'unnamed' });
    publish({ status: 'ready', ...(version ? { version } : {}) });
  }) as (...args: never[]) => void);

  autoUpdater.on('error', ((error: unknown) => {
    const message = readable(error);
    // An unreachable feed is normal on a bad network. It is worth a line, not
    // a dialog, and never a reason to stop starting up.
    log.warn('update check failed', { reason: message });
    publish({ status: 'error', message });
  }) as (...args: never[]) => void);

  const check = async (): Promise<UpdateState> => {
    if (disposed || inFlight) return state;
    // A download in progress, or one already waiting to be installed, is
    // further along than any new check could get. Re-checking would throw away
    // the very state the footer's restart affordance is reading.
    if (state.status === 'downloading' || state.status === 'ready') return state;
    inFlight = true;
    publish({ status: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const message = readable(error);
      log.warn('update check failed', { reason: message });
      publish({ status: 'error', message });
    } finally {
      // Always: a check that finished without ever firing an event must not
      // wedge the flag and silence every check after it.
      inFlight = false;
    }
    return state;
  };

  return {
    start() {
      if (disposed || timer) return;
      void check();
      timer = setInterval(() => void check(), intervalMs);
      // Nothing about updates should keep a process alive on its own.
      timer.unref?.();
    },
    check,
    state: () => state,
    quitAndInstall() {
      if (state.status !== 'ready') {
        log.debug('no update to install');
        return false;
      }
      if (isBusy()) {
        // The whole point. A layup is a person on the other end of a call.
        log.info('holding an update back until the layup ends');
        return false;
      }
      log.info('restarting into the new version', { version: state.version ?? 'unnamed' });
      autoUpdater.quitAndInstall();
      return true;
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
