#!/usr/bin/env node
/**
 * Forced-relay verification against a real coturn, in a container.
 *
 *   node test/network/turn-relay.mjs
 *
 * This closes the half of the TURN test mode that needs infrastructure: two
 * peer connections, relay-only, actually connecting *through* a TURN server and
 * reporting a relay candidate. It does not need two machines - only a real
 * coturn - so it can run continuously rather than once by hand.
 *
 * What it still does not prove: latency across a real network. That needs two
 * physical machines and is tracked in STATUS.md.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(repoRoot, 'apps', 'desktop');
const CONTAINER = 'layup-turn-verify';
const REALM = 'layup.test';
const PORT = 3478;
const RELAY_MIN = 49160;
const RELAY_MAX = 49180;

const secret = randomBytes(32).toString('hex');

/**
 * Chromium ignores TURN servers on a loopback address: it gathers no relay
 * candidates at all and fails silently. coturn must therefore advertise, and be
 * dialled on, a real interface address - even for a single-machine test.
 */
function hostAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  throw new Error('no non-loopback IPv4 address found; TURN cannot be verified on loopback');
}

const host = hostAddress();

/** coturn REST credentials - the same scheme the control service issues. */
function credentials(userId, ttlSeconds = 600) {
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${userId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

const docker = (args, options = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', stdio: 'pipe', ...options });

function stopContainer() {
  docker(['rm', '-f', CONTAINER]);
}

function startCoturn() {
  stopContainer();
  const result = docker([
    'run', '-d', '--name', CONTAINER,
    '-p', `${PORT}:${PORT}/udp`,
    '-p', `${PORT}:${PORT}/tcp`,
    '-p', `${RELAY_MIN}-${RELAY_MAX}:${RELAY_MIN}-${RELAY_MAX}/udp`,
    'coturn/coturn:4.6',
    '-n',
    '--log-file=stdout',
    `--listening-port=${PORT}`,
    '--fingerprint',
    '--use-auth-secret',
    `--static-auth-secret=${secret}`,
    `--realm=${REALM}`,
    // Relay candidates must be reachable from the browser, and Chromium will
    // not use a loopback TURN server, so coturn advertises this machine's
    // interface address.
    `--external-ip=${host}`,
    `--min-port=${RELAY_MIN}`,
    `--max-port=${RELAY_MAX}`,
    '--no-cli',
    '--no-tlsv1',
    '--no-tlsv1_1',
  ]);
  if (result.status !== 0) {
    throw new Error(`could not start coturn: ${result.stderr || result.stdout}`);
  }
}

async function waitForCoturn() {
  for (let i = 0; i < 60; i += 1) {
    const logs = docker(['logs', CONTAINER]).stdout ?? '';
    if (/Total General servers|listener opened on/i.test(logs)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`coturn did not become ready:\n${docker(['logs', CONTAINER]).stdout}`);
}

try {
  console.log('starting coturn in a container…');
  startCoturn();
  await waitForCoturn();

  const { username, credential } = credentials('usr_devnickx');
  console.log(`coturn ready on ${host}:${PORT}, credentials issued for usr_devnickx`);

  execFileSync('npm', ['run', 'build:webrtc'], { cwd: desktop, stdio: 'ignore' });
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'electron'), ['test/webrtc/main.cjs'], {
    cwd: desktop,
    stdio: 'inherit',
    env: {
      ...process.env,
      // These switch the relay scenario from "must not connect" to "must
      // connect through the relay".
      LAYUP_TEST_TURN_URL: `turn:${host}:${PORT}?transport=udp`,
      LAYUP_TEST_TURN_USERNAME: username,
      LAYUP_TEST_TURN_CREDENTIAL: credential,
    },
  });
  console.log('TURN RELAY OK');
} finally {
  stopContainer();
}
