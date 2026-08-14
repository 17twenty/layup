/**
 * Single-screen takeover, over the real wire (SPEC.md §7.1, §7.2, ADR-0007).
 *
 *   node --test test/e2e/screen-takeover.test.mjs
 *
 * Two rules that look similar and are not:
 *
 *   - in a collaborative layup you **take** the screen. There is no approval
 *     dialog, because asking a colleague for permission to show them something
 *     is not how people work. The previous presenter is told;
 *   - in an advertised, organisation-open session you **ask**. An audience
 *     member cannot take the screen out from under a talk mid-sentence.
 *
 * And underneath both: exactly one shared desktop exists, ever.
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
const port = 9600 + (process.pid % 40);
const baseUrl = `http://127.0.0.1:${port}`;

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
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a non-envelope body is still a status worth asserting on */
  }
  return { status: response.status, body: parsed };
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'layup-takeover-'));
  const binary = join(dir, 'control');
  execFileSync('go', ['build', '-o', binary, './cmd/control'], { cwd: controlDir, stdio: 'inherit' });
  server = spawn(binary, [], {
    env: { ...process.env, LAYUP_LISTEN_ADDR: `127.0.0.1:${port}`, LAYUP_ENV: 'e2e' },
    stdio: 'ignore',
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the control service never became healthy');
});

after(() => server?.kill('SIGTERM'));

async function activeShare(devUser, layupId) {
  const { body } = await api(devUser, 'GET', `/api/layups/${layupId}`);
  return body.payload?.activeShare;
}

test('a collaborative layup is taken, not requested', async () => {
  const created = await api('nick', 'POST', '/api/layups', { title: 'Pairing', visibility: 'LINK' });
  const layupId = created.body.payload.layup.id;

  const link = await api('nick', 'POST', `/api/layups/${layupId}/link`);
  const joined = await api('karl', 'POST', `/api/links/${link.body.payload.token}/join`);
  assert.equal(joined.status, 200);

  const first = await api('nick', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:1:0' });
  assert.equal(first.status, 200);

  // No approval dialog: Karl simply takes it.
  const takeover = await api('karl', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:2:0' });
  assert.equal(takeover.status, 200);
  assert.notEqual(takeover.body.payload.id, first.body.payload.id);

  // Asking, here, would be permission theatre - and is refused as such.
  const asked = await api('nick', 'POST', `/api/layups/${layupId}/share/request`);
  assert.equal(asked.status, 409);

  // Exactly one shared desktop, as seen by everybody.
  const asKarl = await activeShare('karl', layupId);
  const asNick = await activeShare('nick', layupId);
  assert.equal(asKarl.id, takeover.body.payload.id);
  assert.deepEqual(asNick, asKarl, 'both participants must see the same single share');
});

test('an advertised session is asked for, not taken', async () => {
  const created = await api('nick', 'POST', '/api/layups', {
    title: 'Advertised session',
    visibility: 'ORGANISATION',
  });
  const layupId = created.body.payload.layup.id;
  assert.equal((await api('karl', 'POST', `/api/layups/${layupId}/join`)).status, 200);

  assert.equal(
    (await api('nick', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:1:0' })).status,
    200,
  );

  // An audience member cannot take the screen mid-sentence.
  const hijack = await api('karl', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:2:0' });
  assert.equal(hijack.status, 403);
  assert.match(hijack.body.payload?.message ?? '', /hand over/i);

  // They ask instead, and asking changes nothing.
  const asked = await api('karl', 'POST', `/api/layups/${layupId}/share/request`);
  assert.equal(asked.status, 200);
  assert.equal(asked.body.payload.askedByName, 'Karl');
  const stillNick = await activeShare('karl', layupId);
  assert.equal(stillNick.presenterMembershipId, (await activeShare('nick', layupId)).presenterMembershipId);
  assert.equal(
    (await api('karl', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:2:0' })).status,
    403,
    'asking must not grant the screen',
  );

  // The presenter hands over by stopping. Then anybody may share.
  assert.equal((await api('nick', 'POST', `/api/layups/${layupId}/share/stop`)).status, 200);
  assert.equal(await activeShare('karl', layupId), undefined);
  assert.equal(
    (await api('karl', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:2:0' })).status,
    200,
  );
});

test('the layup outlives the screen', async () => {
  const created = await api('nick', 'POST', '/api/layups', { title: 'Continuity', visibility: 'LINK' });
  const layupId = created.body.payload.layup.id;
  const link = await api('nick', 'POST', `/api/layups/${layupId}/link`);
  await api('karl', 'POST', `/api/links/${link.body.payload.token}/join`);

  await api('nick', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:1:0' });
  await api('nick', 'POST', `/api/layups/${layupId}/share/stop`);

  // Stopping the share leaves the memberships alone: audio and video carry on.
  const after = await api('karl', 'GET', `/api/layups/${layupId}`);
  assert.equal(after.body.payload.active, true);
  assert.equal(after.body.payload.participants.filter((entry) => entry.active !== false).length, 2);
  assert.equal(after.body.payload.activeShare, undefined);

  // And the presenter walking out entirely leaves the layup standing.
  await api('nick', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:1:0' });
  assert.equal((await api('nick', 'POST', `/api/layups/${layupId}/leave`)).status, 200);

  const afterLeaving = await api('karl', 'GET', `/api/layups/${layupId}`);
  assert.equal(afterLeaving.body.payload.active, true);
  assert.equal(afterLeaving.body.payload.activeShare, undefined, 'no phantom share may survive');

  // Karl, still there, can share now.
  assert.equal(
    (await api('karl', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:2:0' })).status,
    200,
  );
});
