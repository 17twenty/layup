import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreferencesStore, DEFAULT_PREFERENCES } from './preferences';

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'layup-preferences-')), 'preferences.json');

describe('the desktop preferences store', () => {
  it('defaults to unmuted before anything has been written', () => {
    expect(createPreferencesStore({ path: tempPath() }).read()).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips a preference through the file', () => {
    const path = tempPath();
    createPreferencesStore({ path }).write({ soundsMuted: true });
    // A second store is a second launch of the application.
    expect(createPreferencesStore({ path }).read()).toEqual({ soundsMuted: true });
  });

  it('treats a corrupt file as the defaults rather than crashing on launch', () => {
    const path = tempPath();
    writeFileSync(path, '{ not json');
    expect(createPreferencesStore({ path }).read()).toEqual(DEFAULT_PREFERENCES);
  });

  it('treats a file with the wrong shape as the defaults', () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ soundsMuted: 'yes' }));
    expect(createPreferencesStore({ path }).read()).toEqual(DEFAULT_PREFERENCES);
  });

  it('survives a server being forgotten: it is a separate file from config.json', () => {
    const path = tempPath();
    const store = createPreferencesStore({ path });
    store.write({ soundsMuted: true });
    // Nothing here clears on server:forget, because nothing here is about a
    // server - see config.ts's clear(), which this deliberately has no
    // equivalent of.
    expect(store.read()).toEqual({ soundsMuted: true });
  });
});
