import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  systemPreferences,
} from 'electron';
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
import { createHelperSupervisor } from './helper-supervisor';
import { createRemoteSession, SHARE_EVENT_TYPES } from './remote-session';
import { createShareBorder } from './share-border';
import { MODE_SPECS } from './window-modes';
import { createWindowModes, type WindowModes } from './window-modes';
import { createWindowRegistry } from './windows';
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

/**
 * The application window. Overlays - the share border, and anything like it -
 * are deliberately not in here: they have no preload to receive events, and
 * counting them as windows breaks the dock icon.
 */
const windows = createWindowRegistry<BrowserWindow>();

/** Pushes a validated event to the application window. */
function broadcast(event: EventName, payload: unknown) {
  windows.send(event, payload);
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
  onChange: (state) => {
    broadcast('layup:changed', state);
    // Grants belong to a share in a layup: changing membership rebuilds the
    // privileged half rather than carrying anything over. A problem in that
    // rebuild must not stop somebody creating or joining a layup, so it is
    // reported rather than thrown back at the caller.
    try {
      remote.setMembership(state.membershipId, state.layup?.id);
      // The layup tells us who is presenting right now, which live events
      // cannot: they only describe what happens next.
      remote.adoptShare(state.layup?.activeShare);
    } catch (error) {
      log.warn('could not rebuild remote-control state for this layup', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  },
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
      else windows.withWindow((window) => window.setOverlayIcon(null, text));
    },
    setTooltip: (label) => {
      windows.withWindow((window) => window.setTitle(label));
    },
    alert: () => {
      if (process.platform === 'darwin') app.dock?.bounce('informational');
      windows.withWindow((window) => {
        if (!window.isFocused()) window.flashFrame(true);
      });
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
  onAccepted: (result) => layups.adopt(result.layup, result.yourMembershipId, result.media),
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

/**
 * The privileged input helper. It lives in the main process only: no preload
 * channel forwards to it, and the renderer only ever learns *whether* remote
 * control is possible (ADR-0006).
 */
const helper = createHelperSupervisor({
  binaryPath:
    process.env.LAYUP_HELPER_BINARY ||
    path.join(process.resourcesPath ?? __dirname, 'layup-input-helper'),
  log: log.with({ component: 'input-helper' }),
});

/**
 * The presenter's displays, keyed by the capture source being shared.
 *
 * A remote click arrives as a fraction of the shared surface; turning that into
 * a pixel needs the bounds of the display it belongs to. Electron reports
 * bounds in logical points, which is the same space CoreGraphics and SendInput
 * take, so no scaling is applied here on purpose.
 */
function sharedDisplays() {
  const sourceId = remote.shareState().share?.sourceId;
  if (!sourceId) return [];
  // Capture source ids look like "screen:69733382:0"; the middle part is the
  // display id.
  const displayId = sourceId.split(':')[1];
  const display = screen.getAllDisplays().find((entry) => String(entry.id) === displayId);
  if (!display) return [];
  return [
    {
      displayId: sourceId,
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
  ];
}

/**
 * The border around the screen you are sharing. It is the indicator that
 * survives you looking at something other than the Layup window.
 */
const shareBorder = createShareBorder({
  displayFor: (sourceId) => {
    const displayId = sourceId.split(':')[1];
    return screen.getAllDisplays().find((entry) => String(entry.id) === displayId);
  },
  createWindow: (bounds) =>
    new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      // It renders a fixed data URL and talks to nothing.
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    }),
});

/** Keeps the border honest about what is being shared and by whom. */
function refreshShareBorder() {
  const share = remote.shareState().share;
  const mine = share && share.presenterMembershipId === layups.state().membershipId;
  if (!mine) {
    shareBorder.update({ state: 'hidden' });
    return;
  }
  // One state: this screen is being shared. Who can act on it is the Layup
  // window's business, not the border's.
  shareBorder.update({
    ...(share.sourceId ? { sourceId: share.sourceId } : {}),
    state: 'sharing',
  });
}

/**
 * Screen-share state, grants and the only path to OS injection. The renderer
 * carries peers' messages here; it never decides anything about them.
 */
const remote = createRemoteSession({
  client: controlClient,
  helper,
  displays: () => sharedDisplays(),
  log: log.with({ component: 'remote-control' }),
  onShareChanged: (state) => {
    broadcast('share:changed', state);
    refreshShareBorder();
  },
  onControlChanged: (state) => broadcast('control:changed', state),
  sendToPeers: (message) => broadcast('control:send', message),
  registerShortcut: (accelerator, handler) => {
    try {
      return globalShortcut.register(accelerator, handler);
    } catch (error) {
      log.warn('the OS refused the emergency revoke shortcut', {
        accelerator,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },
  unregisterShortcut: (accelerator) => {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // Never registered, or already gone. Nothing to do either way.
    }
  },
});



for (const type of SHARE_EVENT_TYPES) {
  realtime.client.on(type, (message) => {
    try {
      remote.applyShareEvent(type, message.payload);
    } catch (error) {
      log.warn('rejected screen-share payload', {
        type,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

// Signalling is relayed, not interpreted: the renderer owns the peer
// connections because that is where Chromium is (ARCHITECTURE.md §2).
for (const type of ['signal.offer', 'signal.answer', 'signal.candidate', 'signal.bye']) {
  realtime.client.on(type, (message) => {
    broadcast('signal:received', { type, message: message.payload });
  });
}

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
    'control:remote': () => {
      const state = helper.state();
      return {
        helperRunning: state.running,
        pointer: state.capabilities?.pointerMove ?? false,
        keyboard: state.capabilities?.keyboard ?? false,
        ...(state.capabilities?.platform ? { platform: state.capabilities.platform } : {}),
        ...(state.detail ? { detail: state.detail } : {}),
      };
    },
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
    'signal:send': (input) =>
      realtime.client.send({ v: PROTOCOL_VERSION, type: input.type, payload: input.message }),
    'share:current': () => remote.shareState(),
    'share:start': (input) => remote.startShare(input.sourceId),
    'share:stop': () => remote.stopShare(),
    'share:ask': () => remote.askToShare(),
    'control:state': () => remote.controlState(),
    'control:allow': (input) => remote.setAllowed(input.scope, input.allowed),
    'control:stop': (input) => remote.stop(input.membershipId),
    'control:resume': (input) => remote.resume(input.membershipId),
    'control:stopAll': () => remote.stopAll(),
    'input:offer': (input) => remote.offer(input.fromMembershipId, input.message),
    'ui:mode': (input) => {
      modes?.apply(input.mode);
      return { mode: modes?.mode() ?? input.mode };
    },
  };
}

/** How big the window is, per mode. Created with the window it manages. */
let modes: WindowModes | undefined;

function createMainWindow(): BrowserWindow {
  const home = MODE_SPECS.home;
  const window = new BrowserWindow({
    width: home.width,
    height: home.height,
    minWidth: home.minWidth,
    minHeight: home.minHeight,
    show: false,
    backgroundColor: '#101216',
    title: 'Layup',
    // The compact pill is mostly chrome with a title bar on it. macOS keeps its
    // native window behaviour with the bar hidden; elsewhere the frame goes and
    // the renderer draws its own controls.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false }),
    webPreferences: secureWebPreferences(__dirname),
  });

  modes?.dispose();
  modes = createWindowModes({
    window,
    workAreaFor: (bounds) => screen.getDisplayMatching(bounds).workArea,
    onApplied: (mode) => {
      if (!window.isDestroyed()) window.webContents.send('ui:mode', { mode });
    },
  });

  // Never resize the window out from under somebody who is moving it.
  window.on('will-resize', () => modes?.hold());
  window.on('will-move', () => modes?.hold());
  window.on('resized', () => {
    modes?.noteUserResize();
    modes?.resume();
  });
  window.on('moved', () => modes?.resume());
  window.on('leave-full-screen', () => modes?.resume());

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

  window.on('closed', () => windows.clear());
  return windows.set(window);
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

  // Put this desktop back where it was. Restarting the application is not
  // leaving the room.
  void layups.restore();

  app.on('activate', () => {
    // The share border is not the application: clicking the dock must reopen
    // the window even while a border is on screen.
    if (!windows.isOpen()) createMainWindow();
  });
});

app.on('before-quit', () => {
  realtime.stop();
  // The helper exits with the desktop; nothing privileged outlives us.
  helper.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => shareBorder.dispose());

// No renderer may ever attach a webview or spawn an unrestricted window.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
