/**
 * Two desktop clients entering the same logical layup, against a real control
 * service. No media, no room codes - just the domain over HTTP + WSS.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlClient, type Layup } from './control-client';
import { createRealtimeClient, type RealtimeClient } from './realtime-client';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const controlDir = join(repoRoot, 'services', 'control');
const port = 9200 + (process.pid % 70);
const baseUrl = `http://127.0.0.1:${port}`;

let server: ChildProcess | undefined;
const realtimeClients: RealtimeClient[] = [];

function client(devUser: string) {
  return createControlClient({ baseUrl, devUser, timeoutMs: 4000 });
}

/** A realtime client that records the layup states it is told about. */
function watcher(devUser: string) {
  const states: Layup[] = [];
  const rt = createRealtimeClient({ baseUrl, devUser, reconnectBaseMs: 100 });
  rt.on('layup.state', (message) => states.push(message.payload as Layup));
  rt.start();
  realtimeClients.push(rt);
  return { rt, states };
}

async function waitUntil<T>(produce: () => T | undefined, label: string, attempts = 100): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    const value = produce();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('two clients in one logical layup', () => {
  beforeAll(() => {
    const binary = join(mkdtempSync(join(tmpdir(), 'layup-layups-')), 'layup-control');
    execFileSync('go', ['build', '-o', binary, './cmd/control'], { cwd: controlDir, stdio: 'inherit' });
    server = spawn(binary, [], {
      env: { ...process.env, LAYUP_LISTEN_ADDR: `127.0.0.1:${port}`, LAYUP_ENV: 'smoke' },
      stdio: 'ignore',
    });
  }, 120_000);

  afterAll(() => {
    for (const rt of realtimeClients) rt.stop();
    server?.kill('SIGTERM');
  });

  it('both clients end up in the same layup, with live membership updates', async () => {
    const nick = client('nick');
    const karl = client('karl');
    const nickWatch = watcher('nick');
    await waitUntil(() => (nickWatch.rt.state().status === 'connected' ? true : undefined), 'nick realtime');

    const created = await nick.createLayup({ title: 'Capture path', visibility: 'ORGANISATION' });
    expect(created.layup.participants).toHaveLength(1);
    expect(created.layup.creatorMembershipId).toBe(created.yourMembershipId);

    const joined = await karl.joinLayup(created.layup.id);
    expect(joined.layup.id).toBe(created.layup.id);
    expect(joined.yourMembershipId).not.toBe(created.yourMembershipId);

    // Nick learns about Karl over the realtime channel, not by asking again.
    const withBoth = await waitUntil(
      () => nickWatch.states.find((state) => state.participants.filter((p) => !p.leftAt).length === 2),
      'nick to see two participants',
    );
    expect(withBoth.participants.map((p) => p.displayName).sort()).toEqual(['Karl', 'Nick']);
  }, 60_000);

  it('the creator leaving devolves authority to nobody and the layup continues', async () => {
    const nick = client('nick');
    const karl = client('karl');
    const karlWatch = watcher('karl');
    await waitUntil(() => (karlWatch.rt.state().status === 'connected' ? true : undefined), 'karl realtime');

    const created = await nick.createLayup({ title: 'Devolution', visibility: 'ORGANISATION' });
    await karl.joinLayup(created.layup.id);

    const afterLeave = await nick.leaveLayup(created.layup.id);
    expect(afterLeave.layup.active).toBe(true);
    expect(afterLeave.layup.hasCreatorAuthority).toBe(false);
    expect(afterLeave.layup.creatorMembershipId).toBeUndefined();

    // Karl is told, and nobody is marked as creator.
    const seen = await waitUntil(
      () => karlWatch.states.find((state) => state.id === created.layup.id && !state.hasCreatorAuthority),
      'karl to see devolution',
    );
    expect(seen.participants.some((p) => p.isCreatorMembership)).toBe(false);

    // The former creator rejoins as an ordinary participant.
    const rejoined = await nick.joinLayup(created.layup.id);
    expect(rejoined.layup.hasCreatorAuthority).toBe(false);
    expect(rejoined.yourMembershipId).not.toBe(created.yourMembershipId);

    const state = await karl.getLayup(created.layup.id);
    expect(state.participants.filter((p) => !p.leftAt)).toHaveLength(2);
    expect(state.participants.some((p) => p.isCreatorMembership)).toBe(false);
  }, 60_000);

  it('the last participant leaving ends the layup', async () => {
    const nick = client('nick');
    const created = await nick.createLayup({ title: 'Solo', visibility: 'ORGANISATION' });
    const after = await nick.leaveLayup(created.layup.id);

    expect(after.layup.active).toBe(false);
    expect(after.layup.endedAt).toBeTruthy();
    await expect(nick.joinLayup(created.layup.id)).rejects.toThrow(/409|conflict/i);
  }, 60_000);

  it('a private layup is invisible to an outsider', async () => {
    const nick = client('nick');
    const karl = client('karl');
    const created = await nick.createLayup({ title: 'Acquisition of Initech', visibility: 'PRIVATE' });

    await expect(karl.getLayup(created.layup.id)).rejects.toThrow(/404|not_found/i);
    await expect(karl.joinLayup(created.layup.id)).rejects.toThrow(/403|forbidden/i);
  }, 60_000);
});
