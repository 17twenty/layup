#!/usr/bin/env node
/**
 * Forced-relay verification against the *deployed* coturn.
 *
 *   node test/network/turn-remote.mjs
 *
 * The containerised sibling (turn-relay.mjs) proves coturn works. This proves
 * the deployment works: that the control service and coturn agree about the
 * shared secret, that 3478 and the relay range are reachable from here, and
 * that a relay-only session connects *through* the real server.
 *
 * It fetches credentials from the deployed /api/turn rather than deriving
 * them locally - that is what actually proves the control service and coturn
 * agree about the secret, which is the failure this test exists to catch.
 *
 * It reuses the same Electron harness and the same three environment
 * variables as turn-relay.mjs, so the scenario being run is identical - only
 * the TURN server differs.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(repoRoot, 'apps', 'desktop');
const domain = process.env.LAYUP_DEPLOY_DOMAIN || 'layup.blah.au';
const devUser = process.env.LAYUP_DEV_USER || 'nick';

// A later plan restricts X-Layup-Dev-User to loopback callers, so a bearer
// token is preferred whenever one is available. Today the control service
// only implements the dev-user header, so LAYUP_TOKEN is unset and this falls
// through to it - that is expected, not a bug in this script.
const authHeaders = process.env.LAYUP_TOKEN
  ? { Authorization: `Bearer ${process.env.LAYUP_TOKEN}` }
  : { 'X-Layup-Dev-User': devUser };

const response = await fetch(`https://${domain}/api/turn`, {
  headers: { 'X-Layup-Protocol-Version': '1', ...authHeaders },
});
if (!response.ok) {
  console.error(`GET /api/turn returned ${response.status}`);
  process.exit(1);
}
const envelope = await response.json();
// The wire shape is the shared protocol envelope: {v, type, payload}
// (protocol/go/envelope.go). GET /api/turn's payload is TurnDTO
// (services/control/internal/httpapi/turn.go): {iceServers, expiresAt,
// forceRelay}. There is no top-level `iceServers` and no `data` wrapper.
const iceServers = envelope.payload?.iceServers ?? [];
const turn = iceServers.find((server) =>
  [].concat(server.urls).some((url) => String(url).startsWith('turn:')),
);
if (!turn) {
  console.error('the control service issued no TURN server; check LAYUP_TURN_URLS and LAYUP_TURN_SECRET');
  console.error(`envelope: ${JSON.stringify(envelope)}`);
  process.exit(1);
}

const url = [].concat(turn.urls).find((u) => String(u).startsWith('turn:'));
console.log(`issued credentials for ${url} (username ${turn.username})`);

execFileSync('npm', ['run', 'build:webrtc'], { cwd: desktop, stdio: 'ignore' });
execFileSync(join(repoRoot, 'node_modules', '.bin', 'electron'), ['test/webrtc/main.cjs'], {
  cwd: desktop,
  stdio: 'inherit',
  env: {
    ...process.env,
    LAYUP_TEST_TURN_URL: url,
    LAYUP_TEST_TURN_USERNAME: turn.username,
    LAYUP_TEST_TURN_CREDENTIAL: turn.credential,
  },
});
console.log('TURN REMOTE OK');
