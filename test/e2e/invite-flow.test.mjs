/**
 * End-to-end proof of the core product moment (SPEC.md §0):
 *
 *   I click Karl -> Karl accepts -> we are in one layup together
 *
 * Runs against a real control service over HTTP and WSS, using only the wire
 * contract. Asserts the click itself starts nothing but a request.
 *
 *   node --test test/e2e/invite-flow.test.mjs
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
const port = 9400 + (process.pid % 50);
const baseUrl = `http://127.0.0.1:${port}`;
const userId = (handle) => `usr_dev${handle}${'x'.repeat(Math.max(0, 8 - (3 + handle.length)))}`;

let server;

async function api(devUser, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-Layup-Protocol-Version': '1',
      'X-Layup-Dev-User': devUser,
      'Content-Type': 'application/json',
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  return { status: response.status, payload: parsed.payload };
}

/** Collects messages of interest pushed to one user. */
function watch(devUser) {
  const messages = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?v=1&devUser=${devUser}`);
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    if (message.type === 'heartbeat') {
      socket.send(JSON.stringify({ v: 1, type: 'heartbeat.ack', payload: { seq: message.payload.seq } }));
    }
  };
  return {
    messages,
    find: (type, predicate = () => true) =>
      messages.filter((m) => m.type === type).find((m) => predicate(m.payload)),
    close: () => socket.close(),
  };
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
  const binary = join(mkdtempSync(join(tmpdir(), 'layup-invite-')), 'layup-control');
  execFileSync('go', ['build', '-o', binary, './cmd/control'], { cwd: controlDir, stdio: 'inherit' });
  server = spawn(binary, [], {
    env: { ...process.env, LAYUP_LISTEN_ADDR: `127.0.0.1:${port}`, LAYUP_ENV: 'e2e' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('control service did not become healthy');
});

after(() => {
  server?.kill('SIGTERM');
});

test('click -> invitation -> accept -> one layup with both people', async () => {
  const karlWatch = watch('karl');
  const nickWatch = watch('nick');
  await waitFor(() => karlWatch.find('hello.ok'), 'karl connected');
  await waitFor(() => nickWatch.find('hello.ok'), 'nick connected');

  // Nick clicks Karl.
  const created = await api('nick', 'POST', '/api/requests', {
    type: 'INVITE_USER_TO_NEW_LAYUP',
    toUserId: userId('karl'),
    note: 'Auth is doing something dumb',
  });
  assert.equal(created.status, 200);
  assert.equal(created.payload.state, 'PENDING');
  assert.equal(created.payload.fromName, 'Nick');

  // The click alone creates no layup and no membership for anyone.
  assert.equal(created.payload.layupId, undefined);
  assert.equal(created.payload.resultLayupId, undefined);
  const nickPresence = await waitFor(
    () =>
      nickWatch.find('presence.update', (p) => p.person.userId === userId('karl')) ??
      nickWatch.find('presence.snapshot'),
    'presence for nick',
  );
  assert.ok(nickPresence, 'presence should keep flowing');

  // Karl is told, prominently and exactly once.
  const incoming = await waitFor(() => karlWatch.find('request.incoming'), 'karl to be invited');
  assert.equal(incoming.payload.fromName, 'Nick');
  assert.equal(incoming.payload.note, 'Auth is doing something dumb');
  assert.equal(karlWatch.messages.filter((m) => m.type === 'request.incoming').length, 1);

  // Karl accepts: one layup, two memberships, both people inside.
  const accepted = await api('karl', 'POST', `/api/requests/${incoming.payload.id}/accept`, {});
  assert.equal(accepted.status, 200);
  const layup = accepted.payload.layup;
  const active = layup.participants.filter((p) => !p.leftAt);
  assert.equal(active.length, 2, 'both people are in the layup');
  assert.deepEqual(active.map((p) => p.displayName).sort(), ['Karl', 'Nick']);
  assert.equal(layup.visibility, 'PRIVATE');
  assert.equal(accepted.payload.request.state, 'ACCEPTED');
  assert.equal(accepted.payload.request.resultLayupId, layup.id);

  // Both sides are told the request resolved, and both see the layup state.
  await waitFor(() => nickWatch.find('request.resolved', (p) => p.state === 'ACCEPTED'), 'nick told');
  await waitFor(
    () => nickWatch.find('layup.state', (p) => p.id === layup.id && p.participants.length === 2),
    'nick to see the layup',
  );

  // Exactly one creator membership exists, and it belongs to the inviter.
  const creators = active.filter((p) => p.isCreatorMembership);
  assert.equal(creators.length, 1);
  assert.equal(creators[0].displayName, 'Nick');

  karlWatch.close();
  nickWatch.close();
});

test('repeated clicks do not produce repeated notifications', async () => {
  const karlWatch = watch('karl');
  await waitFor(() => karlWatch.find('hello.ok'), 'karl connected');

  const first = await api('nick', 'POST', '/api/requests', {
    type: 'INVITE_USER_TO_NEW_LAYUP',
    toUserId: userId('karl'),
  });
  const second = await api('nick', 'POST', '/api/requests', {
    type: 'INVITE_USER_TO_NEW_LAYUP',
    toUserId: userId('karl'),
  });
  assert.equal(second.payload.id, first.payload.id, 'the pending request is reused');

  await waitFor(() => karlWatch.find('request.incoming'), 'the single notification');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    karlWatch.messages.filter((m) => m.type === 'request.incoming').length,
    1,
    'one notification for repeated clicks',
  );

  // Declining is final.
  const declined = await api('karl', 'POST', `/api/requests/${first.payload.id}/decline`, {});
  assert.equal(declined.status, 200);
  const reaccept = await api('karl', 'POST', `/api/requests/${first.payload.id}/accept`, {});
  assert.equal(reaccept.status, 409);

  karlWatch.close();
});
