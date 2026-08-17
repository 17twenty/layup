import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigStore } from './config';

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'layup-config-')), 'config.json');

describe('the desktop configuration store', () => {
  it('has nothing to say before a server has been added', () => {
    expect(createConfigStore({ path: tempPath() }).read()).toBeUndefined();
  });

  it('round-trips a server through the file', () => {
    const path = tempPath();
    const config = { serverUrl: 'https://layup.blah.au', token: 't0ken', userId: 'usr_abc12345', displayName: 'Nick' };
    createConfigStore({ path }).write(config);
    // A second store is a second launch of the application.
    expect(createConfigStore({ path }).read()).toEqual(config);
  });

  it('treats a corrupt file as no configuration rather than crashing on launch', () => {
    const path = tempPath();
    writeFileSync(path, '{ not json');
    expect(createConfigStore({ path }).read()).toBeUndefined();
  });

  it('forgets everything on clear, so a wrong server can be escaped', () => {
    const path = tempPath();
    const store = createConfigStore({ path });
    store.write({ serverUrl: 'https://layup.blah.au', token: 't', userId: 'usr_abc12345', displayName: 'Nick' });
    store.clear();
    expect(store.read()).toBeUndefined();
  });
});
