/**
 * Two desktop clients, one real control service: do they see each other?
 *
 * This is the PLAN-1 Phase B gate in miniature - presence without polling, and
 * no private layup detail leaking to an outsider.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRealtimeClient, type RealtimeClient } from './realtime-client';
import { createPeopleStore, TYPE_PRESENCE_SNAPSHOT, TYPE_PRESENCE_UPDATE, type Person } from './people-store';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const controlDir = join(repoRoot, 'services', 'control');
const port = 9100 + (process.pid % 80);
const baseUrl = `http://127.0.0.1:${port}`;

let server: ChildProcess | undefined;
const started: RealtimeClient[] = [];

function connect(devUser: string) {
  const client = createRealtimeClient({ baseUrl, devUser, reconnectBaseMs: 100 });
  const store = createPeopleStore();
  for (const type of [TYPE_PRESENCE_SNAPSHOT, TYPE_PRESENCE_UPDATE]) {
    client.on(type, (message) => store.apply(message));
  }
  client.start();
  started.push(client);
  return { client, store };
}

async function waitUntil<T>(produce: () => T | undefined, label: string, attempts = 100): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    const value = produce();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const findPerson = (store: { people(): Person[] }, name: string, predicate: (p: Person) => boolean) => () => {
  const person = store.people().find((p) => p.displayName === name);
  return person && predicate(person) ? person : undefined;
};

describe('presence between two desktop clients', () => {
  beforeAll(() => {
    const binary = join(mkdtempSync(join(tmpdir(), 'layup-presence-')), 'layup-control');
    execFileSync('go', ['build', '-o', binary, './cmd/control'], { cwd: controlDir, stdio: 'inherit' });
    server = spawn(binary, [], {
      env: { ...process.env, LAYUP_LISTEN_ADDR: `127.0.0.1:${port}`, LAYUP_ENV: 'smoke' },
      stdio: 'ignore',
    });
  }, 120_000);

  afterAll(() => {
    for (const client of started) client.stop();
    server?.kill('SIGTERM');
  });

  it('shows the whole organisation on connect', async () => {
    const nick = connect('nick');
    const people = await waitUntil(
      () => (nick.store.people().length >= 4 ? nick.store.people() : undefined),
      'a presence snapshot',
    );
    expect(people.map((p) => p.displayName)).toEqual(['Emelia', 'Karl', 'Nick', 'Priya']);
    expect(people.find((p) => p.displayName === 'Nick')?.personal).toBe('AVAILABLE');
    expect(people.find((p) => p.displayName === 'Karl')?.personal).toBe('OFFLINE');
  }, 60_000);

  it('sees the other person come online and go offline, without polling', async () => {
    const nick = connect('nick');
    await waitUntil(findPerson(nick.store, 'Nick', (p) => p.personal === 'AVAILABLE'), 'self online');

    const karl = connect('karl');
    await waitUntil(findPerson(nick.store, 'Karl', (p) => p.personal === 'AVAILABLE'), 'karl online');

    karl.client.stop();
    await waitUntil(findPerson(nick.store, 'Karl', (p) => p.personal === 'OFFLINE'), 'karl offline');
  }, 60_000);

  it('never receives private layup detail for someone else', async () => {
    const nick = connect('nick');
    const snapshot = await waitUntil(
      () => (nick.store.people().length >= 4 ? nick.store.people() : undefined),
      'a presence snapshot',
    );
    for (const person of snapshot) {
      if (person.displayName === 'Nick') continue;
      if (person.activity === 'IN_PRIVATE_LAYUP') {
        expect(person.layupId).toBeUndefined();
        expect(person.layupTitle).toBeUndefined();
      }
    }
  }, 60_000);
});
