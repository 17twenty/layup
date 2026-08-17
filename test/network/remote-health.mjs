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
 * Authentication: if LAYUP_TOKEN is set, it is sent as a bearer token (both
 * an Authorization header on the HTTPS request and a `token=` query param on
 * the WebSocket URL, which cannot carry headers). Otherwise this falls back
 * to the dev-user identity (query param / X-Layup-Dev-User header) the
 * control service currently accepts. A later plan restricts the dev-user
 * header to loopback callers, which would 401 this harness from off-host -
 * the bearer path is what keeps this script working after that lands.
 * /healthz needs no auth either way.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// protocol/VERSION is the single source of truth (README). Reading it keeps
// this script free of app imports, matching turn-relay.mjs beside it.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROTOCOL_VERSION = readFileSync(join(repoRoot, 'protocol', 'VERSION'), 'utf8').trim();

const domain = process.env.LAYUP_DEPLOY_DOMAIN || 'layup.blah.au';
const devUser = process.env.LAYUP_DEV_USER || 'nick';
const token = process.env.LAYUP_TOKEN;

const fail = (message) => {
  console.error(`REMOTE HEALTH FAILED: ${message}`);
  process.exit(1);
};

// 1. HTTPS through Caddy to the control service.
const healthHeaders = token ? { Authorization: `Bearer ${token}` } : {};
const health = await fetch(`https://${domain}/healthz`, { headers: healthHeaders }).catch((error) =>
  fail(`GET /healthz: ${error.message}`),
);
if (!health.ok) fail(`GET /healthz returned ${health.status}`);
const body = await health.json();
if (body.status !== 'ok') fail(`/healthz status is ${JSON.stringify(body.status)}, expected "ok"`);
console.log(`healthz ok - protocol ${body.protocolVersion ?? '?'}, build ${body.build?.revision ?? '?'}`);

// 2. The WebSocket upgrade, with the same handshake the desktop sends. The
// protocol version travels as `v=` and identity as `devUser=`/`token=` on the
// query string (protocol/go/realtime.go) because the desktop's WebSocket
// client cannot set request headers.
// The WHATWG WebSocket constructor (browser and Node's undici polyfill
// alike) has no way to set an Authorization header, so the bearer token
// travels as a query param here just like the dev-user fallback does.
const identityParam = token ? `token=${encodeURIComponent(token)}` : `devUser=${encodeURIComponent(devUser)}`;
const url = `wss://${domain}/api/realtime?v=${PROTOCOL_VERSION}&${identityParam}`;
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
