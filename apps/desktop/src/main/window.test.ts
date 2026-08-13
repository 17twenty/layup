import { describe, expect, it } from 'vitest';
import { secureWebPreferences } from './window';

describe('window security options', () => {
  const prefs = secureWebPreferences('/app/dist/main/main');

  it('keeps the renderer unprivileged', () => {
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.webviewTag).toBe(false);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.experimentalFeatures).toBe(false);
  });

  it('points at the bundled preload', () => {
    expect(prefs.preload).toBe('/app/dist/preload/index.js');
  });
});
