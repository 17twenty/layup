/**
 * End-to-end proof that the presenter's drawing switch is *enforced*, not
 * merely hidden (SPEC.md §7.3, ADR-0005).
 *
 * Over the real wire, with no application code imported: a viewer who ignores
 * the toggle - or has not received it yet - is refused by the server.
 *
 *   node --test test/e2e/drawing-toggle.test.mjs
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
const port = 9500 + (process.pid % 40);
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
    /* an error body that is not an envelope is still a status we can assert */
  }
  return { status: response.status, payload: parsed.payload };
}

before(async () => {
  const binary = join(mkdtempSync(join(tmpdir(), 'layup-drawing-')), 'layup-control');
  execFileSync('go', ['build', '-o', binary, './cmd/control'], { cwd: controlDir, stdio: 'inherit' });
  server = spawn(binary, [], {
    env: { ...process.env, LAYUP_LISTEN_ADDR: `127.0.0.1:${port}`, LAYUP_ENV: 'e2e' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('control service did not become healthy');
});

after(() => server?.kill('SIGTERM'));

test('the presenter can switch drawing off, and it is enforced for everyone else', async () => {
  const created = await api('nick', 'POST', '/api/layups', {
    title: 'Drawing safety',
    visibility: 'ORGANISATION',
  });
  const layupId = created.payload.layup.id;
  assert.equal((await api('karl', 'POST', `/api/layups/${layupId}/join`, {})).status, 200);
  assert.equal((await api('nick', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:1:0' })).status, 200);

  // Allowed by default.
  assert.equal((await api('karl', 'GET', `/api/layups/${layupId}/share/drawing`)).status, 200);

  // The presenter switches it off.
  const disabled = await api('nick', 'POST', `/api/layups/${layupId}/share/settings`, {
    allowDrawing: false,
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.payload.allowDrawing, false);

  // A client that ignores the toggle is refused, not merely un-rendered.
  const refused = await api('karl', 'GET', `/api/layups/${layupId}/share/drawing`);
  assert.equal(refused.status, 403, 'drawing must be rejected server-side once disabled');

  // The layup state carries the switch, so a late joiner learns it too.
  const state = await api('karl', 'GET', `/api/layups/${layupId}`);
  assert.equal(state.payload.activeShare.allowDrawing, false);

  // Re-enabling permits new strokes again.
  assert.equal(
    (await api('nick', 'POST', `/api/layups/${layupId}/share/settings`, { allowDrawing: true })).status,
    200,
  );
  assert.equal((await api('karl', 'GET', `/api/layups/${layupId}/share/drawing`)).status, 200);
});

test('drawing control is presenter sovereignty, not moderation', async () => {
  const created = await api('nick', 'POST', '/api/layups', { title: 'Sovereignty', visibility: 'ORGANISATION' });
  const layupId = created.payload.layup.id;
  await api('karl', 'POST', `/api/layups/${layupId}/join`, {});
  await api('nick', 'POST', `/api/layups/${layupId}/share`, { sourceId: 'screen:1:0' });

  // A viewer cannot change the switches on somebody else's screen.
  const attempt = await api('karl', 'POST', `/api/layups/${layupId}/share/settings`, { allowDrawing: false });
  assert.equal(attempt.status, 403);

  // And the presenter can always annotate their own screen.
  await api('nick', 'POST', `/api/layups/${layupId}/share/settings`, { allowDrawing: false });
  assert.equal((await api('nick', 'GET', `/api/layups/${layupId}/share/drawing`)).status, 200);
});
