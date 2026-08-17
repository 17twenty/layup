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
import { readFileSync } from 'node:fs';
import { autoUpdater } from 'electron-updater';
import { PROTOCOL_VERSION } from '@layup/protocol';
import { registerIpcHandlers, type Handlers } from './ipc';
import type { EventName } from '../shared/ipc';
import { resolveBuildInfo, type BuildInfo } from '../shared/build-info';
import { createControlSupervisor, DEFAULT_CONTROL_URL, DEFAULT_DEV_USER } from './control';
import { createLogger, newCorrelationId } from './logging';
import { createRealtimeSupervisor } from './realtime';
import { createPeopleStore, TYPE_PRESENCE_SNAPSHOT, TYPE_PRESENCE_UPDATE } from '../core/people-store';
import { createControlClient, type ControlClient } from '../core/control-client';
import { createConfigStore, type DesktopConfig } from './config';
import { createPreferencesStore, type DesktopPreferences } from './preferences';
import { registerWithServer } from './server';
import { parseJoinLink } from './deep-link';
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
import { createUpdater } from './updater';

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

const devUser = process.env.LAYUP_DEV_USER || DEFAULT_DEV_USER;

/**
 * The server this desktop belongs to, and the token that proves who we are.
 *
 * It lives beside the application data, is written 0600 and is never logged.
 * Without it there is no server to ask anything of, and the window shows the
 * add-a-server screen instead of a directory (SPEC.md §2.1).
 */
const configStore = createConfigStore({
  path: path.join(app.getPath('userData'), 'config.json'),
});

let config: DesktopConfig | undefined = configStore.read();

/**
 * Preferences that exist whether or not a server has been added - and, unlike
 * `config`, survive `server:forget`. Starts with one: whether the arrival
 * knock is muted.
 */
const preferencesStore = createPreferencesStore({
  path: path.join(app.getPath('userData'), 'preferences.json'),
});

let preferences: DesktopPreferences = preferencesStore.read();

/**
 * Where the control plane is right now.
 *
 * A stored server wins: it is the one somebody deliberately joined. Without
 * one, LAYUP_CONTROL_URL and the local default keep the development loop
 * working with no config file at all.
 */
function serverUrl(): string {
  return config?.serverUrl ?? process.env.LAYUP_CONTROL_URL ?? DEFAULT_CONTROL_URL;
}

function controlClientOptions() {
  return {
    baseUrl: serverUrl(),
    devUser,
    ...(config ? { token: config.token } : {}),
  };
}

/**
 * The control client, replaceable underneath everything that holds it.
 *
 * Adding a server changes the address, and the address is fixed when a client
 * is built - so a new client is built and the supervisors keep the handle they
 * were given rather than being rewired one by one.
 */
let liveControlClient = createControlClient(controlClientOptions());

const controlClient = new Proxy({} as ControlClient, {
  get: (_target, property) => {
    const value = Reflect.get(liveControlClient as unknown as object, property) as unknown;
    return typeof value === 'function' ? value.bind(liveControlClient) : value;
  },
}) as ControlClient;

/**
 * Connectivity and identity, rebuilt when the server changes: it caches a
 * resolved identity, and that identity belonged to the previous server.
 */
function buildControlSupervisor() {
  return createControlSupervisor({
    baseUrl: serverUrl(),
    devUser,
    client: controlClient,
    log: log.with({ component: 'control-client' }),
  });
}

let control = buildControlSupervisor();

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
  // Read at every connect, so adding a server moves the socket to it.
  baseUrl: () => serverUrl(),
  token: () => config?.token,
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
      // The renderer's knock is driven by this exact call, not a second
      // reading of `requests:changed` - so the sound and the bounce can never
      // disagree about which arrivals are new.
      broadcast('attention:alert', undefined);
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

const permissions = createPermissionService({
  systemPreferences,
  openExternal: (url) => shell.openExternal(url),
  // Accessibility is read from the helper's own AXIsProcessTrusted answer, not
  // guessed here: it is the process that would actually post the event, and a
  // guess is what makes remote control fail without saying anything.
  helperState: () => helper.state(),
  log: log.with({ component: 'permissions' }),
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

/**
 * Keeping this desktop current, without ever restarting somebody mid-call.
 *
 * `isBusy` is the whole safety property: while there is a layup there is a
 * person on the other end of it, and no update is worth interrupting them.
 * Downloading happens quietly; restarting only happens when somebody clicks
 * the line in the footer with no layup running (Task 2, PLAN 0.2.0).
 */
const updater = createUpdater({
  log: log.with({ component: 'updater' }),
  autoUpdater,
  isBusy: () => Boolean(layups.state().layup),
  onChanged: (state) => broadcast('update:changed', state),
});

/** What the renderer is told about the server. Never the token. */
function serverState() {
  return {
    configured: config !== undefined,
    ...(config ? { serverUrl: config.serverUrl, displayName: config.displayName } : {}),
  };
}

/**
 * Points this desktop at whatever the config now says.
 *
 * The control client is rebuilt because its address is fixed at construction;
 * the realtime socket is stopped and started because it reads the address when
 * it connects. Everything downstream keeps the handles it was given.
 */
function applyServerConfig() {
  realtime.stop();
  liveControlClient = createControlClient(controlClientOptions());
  control = buildControlSupervisor();
  realtime.start();
  broadcast('server:changed', serverState());
}

function buildHandlers(): Handlers {
  return {
    'app:info': () => ({
      appVersion: app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform as 'darwin' | 'win32' | 'linux',
    }),
    'server:state': () => serverState(),
    'server:add': async (input) => {
      const outcome = await registerWithServer({
        serverUrl: input.serverUrl,
        code: input.code,
        displayName: input.displayName,
      });
      if (!outcome.ok) {
        // The server's own sentence, unchanged: it is the one that tells
        // somebody whether to fix the code or the address.
        log.warn('could not add server', { reason: outcome.message });
        return { ok: false, message: outcome.message };
      }
      configStore.write(outcome.config);
      config = outcome.config;
      // Logged without the token, on purpose.
      log.info('server added', { serverUrl: config.serverUrl, userId: config.userId });
      applyServerConfig();
      // The directory is only worth restoring once there is a server to ask.
      void layups.restore();
      return { ok: true };
    },
    'server:forget': () => {
      configStore.clear();
      config = undefined;
      log.info('server forgotten');
      applyServerConfig();
      return serverState();
    },
    'capture:sources': () => capture.listSources().then((sources) => ({ sources })),
    'capture:permission': () => permissions.capture(),
    'capture:openSettings': () => permissions.openCaptureSettings(),
    'permissions:all': () => permissions.all(),
    'permissions:request': (input) => permissions.request(input.kind),
    'permissions:openSettings': (input) => permissions.openSettings(input.kind),
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
    'update:state': () => updater.state(),
    'update:install': () => updater.quitAndInstall(),
    'preferences:get': () => preferences,
    'preferences:set': (input) => {
      preferences = input;
      preferencesStore.write(preferences);
      log.info('preferences changed', { soundsMuted: preferences.soundsMuted });
      return preferences;
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

/**
 * Which build this is, from the main process's point of view.
 *
 * The renderer gets its stamp from Vite `define`; tsc has no such mechanism,
 * so electron-builder writes it into the packaged package.json instead (see
 * the `package` script). A development run has neither and honestly says `dev`.
 */
function mainBuildInfo(): BuildInfo {
  let stamped: { layupCommit?: unknown; layupBuiltAt?: unknown } = {};
  try {
    stamped = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
  } catch {
    // An unreadable package.json is not a reason not to start.
  }
  return resolveBuildInfo({
    version: app.getVersion(),
    commit: stamped.layupCommit,
    builtAt: stamped.layupBuiltAt,
  });
}

app.whenReady().then(() => {
  const build = mainBuildInfo();
  log.info('desktop starting', {
    version: build.version,
    commit: build.commit,
    builtAt: build.builtAt,
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

  // A development run has no feed and no signature to check against, so asking
  // would only produce an error nobody caused.
  if (app.isPackaged) updater.start();

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
  updater.dispose();
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

/**
 * The join link. Registering `layup://` makes a link from the join page
 * (deploy/vm/public/join/index.html) open this app directly; macOS delivers
 * it as `open-url` rather than through argv, which is the only route this
 * handles for now (ADR: Windows/Linux argv parsing is future work, not part
 * of this dogfood).
 *
 * A link that fails to parse - wrong scheme, no code, or a non-https server -
 * is silently ignored rather than surfaced as an error nobody caused.
 */
app.setAsDefaultProtocolClient('layup');

app.on('open-url', (event, url) => {
  event.preventDefault();
  const link = parseJoinLink(url);
  if (link) broadcast('server:prefill', link);
});
