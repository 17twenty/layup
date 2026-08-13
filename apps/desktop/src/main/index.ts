import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import { PROTOCOL_VERSION } from '@layup/protocol';
import { registerIpcHandlers, type Handlers } from './ipc';
import type { EventName } from '../shared/ipc';
import { createControlSupervisor, DEFAULT_CONTROL_URL, DEFAULT_DEV_USER } from './control';
import { createLogger, newCorrelationId } from './logging';
import { createRealtimeSupervisor } from './realtime';
import { createPeopleStore, TYPE_PRESENCE_SNAPSHOT, TYPE_PRESENCE_UPDATE } from '../core/people-store';
import { secureWebPreferences } from './window';

/**
 * Electron main process. Owns windows, capture, media and the privileged side
 * of the IPC boundary. The renderer stays unprivileged (ARCHITECTURE.md §2).
 */

const RENDERER_DEV_URL = process.env.LAYUP_RENDERER_URL;

/** Every line from this process carries the component and app session id. */
const log = createLogger({
  level: (process.env.LAYUP_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
  base: { component: 'desktop-main', appSessionId: newCorrelationId() },
});

const controlUrl = process.env.LAYUP_CONTROL_URL || DEFAULT_CONTROL_URL;
const devUser = process.env.LAYUP_DEV_USER || DEFAULT_DEV_USER;

const control = createControlSupervisor({
  baseUrl: controlUrl,
  devUser,
  log: log.with({ component: 'control-client' }),
});

/** Pushes a validated event to every open window. */
function broadcast(event: EventName, payload: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(event, payload);
  }
}

const realtime = createRealtimeSupervisor({
  baseUrl: controlUrl,
  devUser,
  log: log.with({ component: 'realtime' }),
  onState: (state) => {
    broadcast('realtime:state', state);
    // A dropped connection means the people list is stale, not empty: the next
    // snapshot replaces it wholesale.
    if (state.status === 'reconnecting') log.debug('people list may be stale');
  },
});

/** People and their presence, fed only by realtime events. */
const people = createPeopleStore();

for (const type of [TYPE_PRESENCE_SNAPSHOT, TYPE_PRESENCE_UPDATE]) {
  realtime.client.on(type, (message) => {
    try {
      if (people.apply(message)) broadcast('people:changed', { people: people.people() });
    } catch (error) {
      log.warn('rejected presence payload', {
        type,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function buildHandlers(): Handlers {
  return {
    'app:info': () => ({
      appVersion: app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform as 'darwin' | 'win32' | 'linux',
    }),
    'control:status': () => control.status(),
    'identity:current': () => control.identity(),
    'realtime:status': () => realtime.state(),
    'people:list': () => ({ people: people.people() }),
  };
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    backgroundColor: '#101216',
    title: 'Layup',
    webPreferences: secureWebPreferences(__dirname),
  });

  window.once('ready-to-show', () => window.show());

  // The renderer never navigates itself anywhere; external links go to the OS.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== RENDERER_DEV_URL) event.preventDefault();
  });

  if (RENDERER_DEV_URL) {
    void window.loadURL(RENDERER_DEV_URL);
  } else {
    void window.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  }

  return window;
}

app.whenReady().then(() => {
  log.info('desktop starting', {
    protocolVersion: PROTOCOL_VERSION,
    platform: process.platform,
    electron: process.versions.electron,
  });

  registerIpcHandlers(ipcMain, buildHandlers(), {
    onRejected: (channel, error) => {
      log.warn('rejected IPC payload', { channel, reason: error.message });
    },
  });

  createMainWindow();
  realtime.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => realtime.stop());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// No renderer may ever attach a webview or spawn an unrestricted window.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
