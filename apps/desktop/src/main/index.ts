import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import { PROTOCOL_VERSION } from '@layup/protocol';
import { registerIpcHandlers, type Handlers } from './ipc';
import { secureWebPreferences } from './window';

/**
 * Electron main process. Owns windows, capture, media and the privileged side
 * of the IPC boundary. The renderer stays unprivileged (ARCHITECTURE.md §2).
 */

const RENDERER_DEV_URL = process.env.LAYUP_RENDERER_URL;

function buildHandlers(): Handlers {
  return {
    'app:info': () => ({
      appVersion: app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform as 'darwin' | 'win32' | 'linux',
    }),
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
  registerIpcHandlers(ipcMain, buildHandlers(), {
    onRejected: (channel, error) => {
      console.error(`[layup] rejected IPC payload on ${channel}: ${error.message}`);
    },
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// No renderer may ever attach a webview or spawn an unrestricted window.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
