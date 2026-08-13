/**
 * End-to-end proof of the creator-devolution invariant (SPEC.md §2.2).
 *
 *   creator membership leaves
 *     -> creator authority disappears permanently
 *     -> nobody inherits it
 *     -> the layup continues
 *     -> the same user rejoins as an ordinary participant
 *
 * This runs against a real control service over real HTTP and a real WebSocket,
 * with no application code imported: only the wire contract is exercised, so it
 * would still catch a regression made anywhere inside the server.
 *
 *   node --test test/e2e/creator-devolution.test.mjs
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const controlDir = join(repoRoot, 'services', 'control');
const port = 9300 + (process.pid % 60);
const baseUrl = `http://127.0.0.1:${port}`;

let server;

const headers = (devUser) => ({
  'X-Layup-Protocol-Version': '1',
  'X-Layup-Dev-User': devUser,
  'Content-Type': 'application/json',
});

async function api(devUser, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(devUser),
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, envelope: payload, payload: payload.payload };
}

async function waitForHealth() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('control service did not become healthy');
}

/** Collects layup.state envelopes pushed to one user. */
function watchLayupState(devUser) {
  const states = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?v=1&devUser=${devUser}`);
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === 'layup.state') states.push(message.payload);
    if (message.type === 'heartbeat') {
      socket.send(JSON.stringify({ v: 1, type: 'heartbeat.ack', payload: { seq: message.payload.seq } }));
    }
  };
  return { states, close: () => socket.close() };
}

async function waitFor(produce, label) {
  for (let i = 0; i < 100; i += 1) {
    const value = produce();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

before(async () => {
  const binary = join(mkdtempSync(join(tmpdir(), 'layup-e2e-')), 'layup-control');
  execFileSync('go', ['build', '-o', binary, './cmd/control'], { cwd: controlDir, stdio: 'inherit' });
  server = spawn(binary, [], {
    env: { ...process.env, LAYUP_LISTEN_ADDR: `127.0.0.1:${port}`, LAYUP_ENV: 'e2e' },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(() => {
  server?.kill('SIGTERM');
});

test('creator leaves: authority disappears, nobody inherits, the layup continues', async () => {
  const watcher = watchLayupState('karl');

  // 1. Nick creates a layup: his membership holds creator authority.
  const created = await api('nick', 'POST', '/api/layups', {
    title: 'Devolution end to end',
    visibility: 'ORGANISATION',
  });
  assert.equal(created.status, 200);
  const layupId = created.payload.layup.id;
  const creatorMembershipId = created.payload.yourMembershipId;
  assert.equal(created.payload.layup.creatorMembershipId, creatorMembershipId);
  assert.equal(created.payload.layup.hasCreatorAuthority, true);

  // 2. Karl joins with a distinct membership id.
  const joined = await api('karl', 'POST', `/api/layups/${layupId}/join`, {});
  assert.equal(joined.status, 200);
  const karlMembershipId = joined.payload.yourMembershipId;
  assert.notEqual(karlMembershipId, creatorMembershipId, 'membership ids must be distinct');
  assert.equal(joined.payload.layup.participants.length, 2);

  // 3. The creator leaves.
  const left = await api('nick', 'POST', `/api/layups/${layupId}/leave`, {});
  assert.equal(left.status, 200);
  const afterLeave = left.payload.layup;

  // ...the layup survives...
  assert.equal(afterLeave.active, true, 'the layup must continue');
  assert.equal(afterLeave.endedAt, undefined);
  assert.equal(afterLeave.participants.filter((p) => !p.leftAt).length, 1);

  // ...authority is gone, and nobody has it...
  assert.equal(afterLeave.hasCreatorAuthority, false, 'creator authority must disappear');
  assert.equal(afterLeave.creatorMembershipId, undefined, 'no membership may be named as creator');
  for (const participant of afterLeave.participants) {
    assert.equal(participant.isCreatorMembership, false, `${participant.displayName} inherited authority`);
  }

  // ...and the remaining participant is told the same thing over realtime.
  const pushed = await waitFor(
    () => watcher.states.find((state) => state.id === layupId && state.hasCreatorAuthority === false),
    'karl to be told authority devolved',
  );
  assert.equal(pushed.creatorMembershipId, undefined);
  assert.equal(pushed.participants.some((p) => p.isCreatorMembership), false);

  // 4. The former creator rejoins: new membership, ordinary participant.
  const rejoined = await api('nick', 'POST', `/api/layups/${layupId}/join`, {});
  assert.equal(rejoined.status, 200);
  assert.notEqual(rejoined.payload.yourMembershipId, creatorMembershipId, 'a rejoin mints a new membership');
  assert.equal(rejoined.payload.layup.hasCreatorAuthority, false, 'authority must not be restored');
  assert.equal(rejoined.payload.layup.creatorMembershipId, undefined);

  const state = (await api('karl', 'GET', `/api/layups/${layupId}`)).payload;
  const active = state.participants.filter((p) => !p.leftAt);
  assert.equal(active.length, 2);
  assert.equal(
    active.some((p) => p.isCreatorMembership),
    false,
    'nobody may hold creator authority after devolution',
  );
  assert.equal(state.hasCreatorAuthority, false);

  // 5. There is no way to ask for it back: no endpoint accepts a creator claim.
  const claim = await fetch(`${baseUrl}/api/layups/${layupId}/creator`, {
    method: 'POST',
    headers: headers('nick'),
    body: '{}',
  });
  assert.equal(claim.status, 404, 'no creator-claim endpoint may exist');

  watcher.close();
});

test('the layup ends only when the last membership leaves', async () => {
  const created = await api('nick', 'POST', '/api/layups', { title: 'Last out', visibility: 'ORGANISATION' });
  const layupId = created.payload.layup.id;
  await api('karl', 'POST', `/api/layups/${layupId}/join`, {});

  const first = await api('nick', 'POST', `/api/layups/${layupId}/leave`, {});
  assert.equal(first.payload.layup.active, true, 'one participant remains');

  const last = await api('karl', 'POST', `/api/layups/${layupId}/leave`, {});
  assert.equal(last.payload.layup.active, false, 'the last leave ends the layup');
  assert.ok(last.payload.layup.endedAt, 'endedAt must be stamped');

  const rejoin = await api('nick', 'POST', `/api/layups/${layupId}/join`, {});
  assert.equal(rejoin.status, 409, 'an ended layup cannot be rejoined');
});
