#!/usr/bin/env node
/**
 * Proves the deployed control plane is reachable the way the desktop needs it.
 *
 *   node test/network/remote-health.mjs
 *
 * Two assertions, because they fail independently: TLS-terminated HTTP, and a
 * WebSocket upgrade proxied through Caddy. A reverse proxy that serves JSON
 * happily while silently refusing the upgrade looks healthy and is useless.
 *
 * Authentication: a bearer token, always. LAYUP_TOKEN is used if set;
 * otherwise this self-registers with LAYUP_JOIN_CODE (test/network/identity.mjs)
 * and uses the token that comes back. The declared dev-user identity is no
 * longer accepted from off-host, so there is no fallback below this - a
 * harness that cannot get a token should say so rather than pretend.
 * The token travels as an Authorization header on the HTTPS request and as a
 * `token=` query param on the WebSocket URL, which cannot carry headers.
 * /healthz needs no auth either way.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveToken } from './identity.mjs';

// protocol/VERSION is the single source of truth (README). Reading it keeps
// this script free of app imports, matching turn-relay.mjs beside it.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROTOCOL_VERSION = readFileSync(join(repoRoot, 'protocol', 'VERSION'), 'utf8').trim();

const domain = process.env.LAYUP_DEPLOY_DOMAIN || 'layup.blah.au';

const fail = (message) => {
  console.error(`REMOTE HEALTH FAILED: ${message}`);
  process.exit(1);
};

const token = await resolveToken({
  domain,
  protocolVersion: PROTOCOL_VERSION,
  displayName: 'remote-health harness',
}).catch((error) => fail(error.message));

// 1. HTTPS through Caddy to the control service.
const healthHeaders = { Authorization: `Bearer ${token}` };
const health = await fetch(`https://${domain}/healthz`, { headers: healthHeaders }).catch((error) =>
  fail(`GET /healthz: ${error.message}`),
);
if (!health.ok) fail(`GET /healthz returned ${health.status}`);
const body = await health.json();
if (body.status !== 'ok') fail(`/healthz status is ${JSON.stringify(body.status)}, expected "ok"`);
console.log(`healthz ok - protocol ${body.protocolVersion ?? '?'}, build ${body.build?.revision ?? '?'}`);

// 2. The WebSocket upgrade, with the same handshake the desktop sends. The
// protocol version travels as `v=` and identity as `token=` on the query
// string (protocol/go/realtime.go), because the WHATWG WebSocket constructor
// - browser and Node alike - has no way to set an Authorization header.
// Caddy's access log redacts that parameter (deploy/vm/Caddyfile); the
// control service never logs it at all.
const url = `wss://${domain}/api/realtime?v=${PROTOCOL_VERSION}&token=${encodeURIComponent(token)}`;
await new Promise((resolve) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => fail('WebSocket did not open within 10s - is the upgrade being proxied?'), 10_000);
  socket.addEventListener('open', () => {
    clearTimeout(timer);
    console.log('realtime upgrade ok');
    socket.close();
    resolve();
  });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    fail('WebSocket errored - Caddy is not passing the upgrade, or the service is down');
  });
});

console.log('REMOTE HEALTH OK');
