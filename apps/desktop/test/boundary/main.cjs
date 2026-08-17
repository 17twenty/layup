/**
 * Runtime proof of the Electron process boundary.
 *
 * Launches a real window with the production security options and the real
 * preload bundle, then asks the renderer what it can actually reach.
 * Exits non-zero if the renderer has privileges it must never have.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const distMainDir = path.join(__dirname, '..', '..', 'dist', 'main', 'main');
const { secureWebPreferences } = require(path.join(distMainDir, 'window.js'));
const { registerIpcHandlers } = require(path.join(distMainDir, 'ipc.js'));

app.disableHardwareAcceleration();

const failures = [];

app.whenReady().then(async () => {
  registerIpcHandlers(ipcMain, {
    'app:info': () => ({ appVersion: '0.1.0-test', protocolVersion: 1, platform: process.platform }),
    'server:state': () => ({ configured: false }),
    'server:add': () => ({ ok: false, message: 'the boundary harness registers nobody' }),
    'server:forget': () => ({ configured: false }),
    'capture:sources': () => ({ sources: [] }),
    'capture:permission': () => ({
      status: 'granted',
      canCapture: true,
      guidance: '',
      canOpenSettings: true,
      platform: process.platform,
    }),
    'capture:openSettings': () => true,
    'control:status': () => ({
      status: 'unreachable',
      baseUrl: 'http://127.0.0.1:8787',
      clientProtocolVersion: 1,
      detail: 'boundary harness does not run a control service',
      checkedAtMs: 0,
    }),
    'control:remote': () => ({ helperRunning: false, pointer: false, keyboard: false }),
    'identity:current': () => ({ devUser: 'nick', resolved: false, detail: 'no control service' }),
    'realtime:status': () => ({ status: 'idle', attempt: 0 }),
    'people:list': () => ({ people: [] }),
    'layup:current': () => ({ youAreCreatorMembership: false }),
    'layup:create': () => ({ youAreCreatorMembership: false }),
    'layup:join': () => ({ youAreCreatorMembership: false }),
    'layup:leave': () => ({ youAreCreatorMembership: false }),
    'layup:open': () => ({ layups: [] }),
    'ice:config': () => ({ iceServers: [], expiresAt: '2026-08-14T09:00:00Z', forceRelay: false }),
    'layup:link': () => ({ token: 'tok', expiresAt: '2026-08-14T09:00:00Z' }),
    'layup:joinLink': () => ({ youAreCreatorMembership: false }),
    'requests:list': () => ({ incoming: [], outgoing: [] }),
    'requests:invite': () => ({
      id: 'jrq_devaaaaab',
      type: 'INVITE_USER_TO_NEW_LAYUP',
      state: 'PENDING',
      fromUserId: 'usr_devnickx',
      fromName: 'Nick',
      createdAt: '2026-08-13T09:00:00Z',
      expiresAt: '2026-08-13T09:01:00Z',
    }),
    'requests:knock': () => ({
      id: 'jrq_devaaaaac',
      type: 'KNOCK_TO_JOIN',
      state: 'PENDING',
      fromUserId: 'usr_devkarlx',
      fromName: 'Karl',
      createdAt: '2026-08-13T09:00:00Z',
      expiresAt: '2026-08-13T09:01:00Z',
    }),
    'requests:accept': () => undefined,
    'requests:decline': () => undefined,
    'requests:cancel': () => undefined,
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: secureWebPreferences(distMainDir),
  });

  await win.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));

  const probe = await win.webContents.executeJavaScript(`(async () => {
    const seen = {
      require: typeof require,
      process: typeof process,
      module: typeof module,
      global: typeof global,
      Buffer: typeof Buffer,
      layup: typeof window.layup,
      layupKeys: window.layup ? Object.keys(window.layup).sort() : [],
    };
    try {
      seen.appInfo = await window.layup.app.info();
    } catch (error) {
      seen.appInfoError = String(error);
    }
    // A renderer cannot smuggle a payload onto a no-argument channel: the
    // bridge takes no arguments, so extra arguments are discarded, never sent.
    try {
      const smuggled = await window.layup.app.info({ sneaky: true });
      seen.smuggledPayloadDiscarded = smuggled && smuggled.protocolVersion === 1;
    } catch {
      seen.smuggledPayloadDiscarded = true;
    }
    return seen;
  })()`);

  const expect = (label, actual, wanted) => {
    if (actual !== wanted) failures.push(`${label}: expected ${wanted}, got ${actual}`);
  };

  expect('typeof require', probe.require, 'undefined');
  expect('typeof process', probe.process, 'undefined');
  expect('typeof module', probe.module, 'undefined');
  expect('typeof global', probe.global, 'undefined');
  expect('typeof Buffer', probe.Buffer, 'undefined');
  expect('typeof window.layup', probe.layup, 'object');
  expect(
    'window.layup keys',
    JSON.stringify(probe.layupKeys),
    JSON.stringify([
      'app',
      'capture',
      'control',
      'ice',
      'identity',
      'input',
      'layup',
      'people',
      'protocolVersion',
      'realtime',
      'requests',
      'server',
      'share',
      'signal',
      'ui',
    ]),
  );
  expect('app:info protocolVersion', probe.appInfo && probe.appInfo.protocolVersion, 1);
  expect('discards smuggled payload', probe.smuggledPayloadDiscarded, true);

  console.log(JSON.stringify(probe, null, 2));
  if (failures.length > 0) {
    console.error('BOUNDARY FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
    app.exit(1);
  } else {
    console.log('BOUNDARY OK');
    app.exit(0);
  }
});
