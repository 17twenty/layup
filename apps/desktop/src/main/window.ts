import * as path from 'node:path';

/**
 * Window security options live here so the hard boundary is testable rather
 * than buried in window construction (SPEC.md §13.1).
 */
export interface WebPreferencesShape {
  preload: string;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  nodeIntegrationInWorker: boolean;
  nodeIntegrationInSubFrames: boolean;
  sandbox: boolean;
  webSecurity: boolean;
  webviewTag: boolean;
  allowRunningInsecureContent: boolean;
  experimentalFeatures: boolean;
}

/** `mainDir` is the directory of the compiled main entry point. */
export function secureWebPreferences(mainDir: string): WebPreferencesShape {
  return {
    // Bundled preload: dist/main/main -> dist/preload/index.js
    preload: path.join(mainDir, '..', '..', 'preload', 'index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
  };
}
