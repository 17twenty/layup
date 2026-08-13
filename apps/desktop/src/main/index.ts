import { app, BrowserWindow, desktopCapturer, ipcMain, shell, systemPreferences } from 'electron';
import * as path from 'node:path';
import { PROTOCOL_VERSION } from '@layup/protocol';
import { registerIpcHandlers, type Handlers } from './ipc';
import type { EventName } from '../shared/ipc';
import { createControlSupervisor, DEFAULT_CONTROL_URL, DEFAULT_DEV_USER } from './control';
import { createLogger, newCorrelationId } from './logging';
import { createRealtimeSupervisor } from './realtime';
import { createPeopleStore, TYPE_PRESENCE_SNAPSHOT, TYPE_PRESENCE_UPDATE } from '../core/people-store';
import { createControlClient } from '../core/control-client';
import { createLayupSupervisor } from './layups';
import { createRequestsSupervisor } from './requests';
import { createAttentionController } from './attention';
import { createCaptureService } from './capture';
import { createPermissionService } from './permissions';
import { createIceSupervisor } from './ice';
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

const controlClient = createControlClient({ baseUrl: controlUrl, devUser });

const control = createControlSupervisor({
  baseUrl: controlUrl,
  devUser,
  client: controlClient,
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

const layups = createLayupSupervisor({
  client: controlClient,
  realtime: realtime.client,
  log: log.with({ component: 'layups' }),
  onChange: (state) => broadcast('layup:changed', state),
});

/**
 * OS attention while someone is waiting: a dock/taskbar badge, a tooltip and a
 * single bounce per new request. No repeated notification for repeated clicks.
 */
const attention = createAttentionController({
  log: log.with({ component: 'attention' }),
  surface: {
    setBadge: (text) => {
      if (process.platform === 'darwin') app.dock?.setBadge(text);
      else for (const window of BrowserWindow.getAllWindows()) window.setOverlayIcon(null, text);
    },
    setTooltip: (label) => {
      for (const window of BrowserWindow.getAllWindows()) window.setTitle(label);
    },
    alert: () => {
      if (process.platform === 'darwin') app.dock?.bounce('informational');
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isFocused()) window.flashFrame(true);
      }
    },
  },
});

const requests = createRequestsSupervisor({
  client: controlClient,
  realtime: realtime.client,
  log: log.with({ component: 'requests' }),
  onChange: (state) => {
    broadcast('requests:changed', state);
    attention.apply(state);
  },
  // Accepting an invitation puts this desktop into the resulting layup.
  onAccepted: (result) => layups.adopt(result.layup, result.yourMembershipId),
});

// A fresh connection means the server may know about requests we do not.
realtime.client.on('hello.ok', () => {
  void requests.refresh().catch((error: unknown) => {
    log.warn('could not refresh requests', {
      reason: error instanceof Error ? error.message : String(error),
    });
  });
});

const capture = createCaptureService({
  desktopCapturer,
  log: log.with({ component: 'capture' }),
});

const permissions = createPermissionService({
  systemPreferences,
  openExternal: (url) => shell.openExternal(url),
  log: log.with({ component: 'permissions' }),
});

const ice = createIceSupervisor({
  client: controlClient,
  log: log.with({ component: 'ice' }),
  // Local switch for exercising the TURN path: LAYUP_FORCE_RELAY=true
  forceRelay: /^(1|true|yes)$/i.test(process.env.LAYUP_FORCE_RELAY ?? ''),
});

function buildHandlers(): Handlers {
  return {
    'app:info': () => ({
      appVersion: app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform as 'darwin' | 'win32' | 'linux',
    }),
    'capture:sources': () => capture.listSources().then((sources) => ({ sources })),
    'capture:permission': () => permissions.capture(),
    'capture:openSettings': () => permissions.openCaptureSettings(),
    'control:status': () => control.status(),
    'identity:current': () => control.identity(),
    'realtime:status': () => realtime.state(),
    'people:list': () => ({ people: people.people() }),
    'layup:current': () => layups.state(),
    'layup:create': (input) => layups.create(input),
    'layup:join': (input) => layups.join(input.layupId),
    'layup:leave': () => layups.leave(),
    'layup:open': () => controlClient.openLayups(),
    'ice:config': () => ice.configuration(),
    'layup:link': () => {
      const current = layups.state().layup;
      if (!current) throw new Error('you are not in a layup');
      return controlClient.createLink(current.id);
    },
    'layup:joinLink': async (input) => {
      const result = await controlClient.joinByLink(input.token);
      return layups.adopt(result.layup, result.yourMembershipId);
    },
    'requests:list': () => requests.state(),
    'requests:invite': (input) =>
      input.layupId
        ? requests.inviteToLayup(input.toUserId, input.layupId)
        : requests.invite(input.toUserId, input.note),
    'requests:knock': (input) => requests.knock(input.toUserId),
    'requests:accept': (input) => requests.accept(input.requestId).then(() => undefined),
    'requests:decline': (input) => requests.decline(input.requestId).then(() => undefined),
    'requests:cancel': (input) => requests.cancel(input.requestId).then(() => undefined),
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
