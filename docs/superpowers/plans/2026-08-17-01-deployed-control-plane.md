# Deployed Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `https://layup.blah.au` serves the control plane that already exists, over TLS, with a real coturn beside it, proven by a forced-relay connection that actually relays.

**Architecture:** Native systemd on Debian 12, not Docker (see spec §4). Caddy terminates TLS on 443 and reverse-proxies `/api/*` and `/healthz` to the control service on loopback, passing the WebSocket upgrade through. coturn runs from apt with host networking. The control service is cross-compiled on the Mac and shipped as a single static binary — no Go toolchain on the VM. **No application code changes in this plan**: the control service already reads every variable this deployment needs.

**Tech Stack:** Debian 12 (x86_64), Caddy 2 (automatic Let's Encrypt), coturn 4.6 (apt), systemd, nftables, Go 1.26.4 cross-compilation.

**Spec:** `docs/superpowers/specs/2026-08-17-two-person-dogfood-design.md`

## Global Constraints

- Target host is `root@157.20.113.124`, Debian 12 bookworm, x86_64, public IP directly on `eth0` (`157.20.113.124/25`), no NAT.
- Domain is `layup.blah.au`, A record to `157.20.113.124`, apex only — **no wildcard**, so every hostname used must be the apex.
- The control service binds `127.0.0.1:8787` and is never exposed directly.
- `LAYUP_TURN_SECRET` is shared between the control service and coturn and **must never be committed**. Generate with `openssl rand -hex 32`.
- Leave `LAYUP_ALLOWED_ORIGINS` unset. `httpapi/realtime.go:55` sets `InsecureSkipVerify` when the allow-list is empty, which is what lets the desktop connect from a `file://` origin.
- Ports permitted from the internet, and no others: 22, 443, 3478 (tcp+udp), 49160–49200 (udp).
- Deployment must be one command. If it is a sequence of remembered ssh invocations it will drift and lie.

---

### Task 1: Deployment assets in the repository

Everything the VM runs is a file in git. Nothing is hand-edited on the server, so the box is reproducible and the configuration is reviewable.

**Files:**
- Create: `deploy/vm/Caddyfile`
- Create: `deploy/vm/layup-control.service`
- Create: `deploy/vm/turnserver.conf`
- Create: `deploy/vm/nftables.conf`
- Create: `deploy/vm/control.env.example`
- Create: `deploy/vm/bootstrap.sh`
- Create: `deploy/vm/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the file set that Task 2 uploads. `bootstrap.sh` is idempotent and safe to re-run.

- [ ] **Step 1: Write the Caddy site file**

`deploy/vm/Caddyfile`. Caddy obtains and renews the certificate by itself; there is no certbot step.

```caddyfile
layup.blah.au {
	encode zstd gzip

	# The control plane. `handle` rather than a bare matcher so ordering is
	# explicit rather than inferred. Caddy proxies the WebSocket upgrade on
	# /api/realtime transparently - no special directive is required.
	handle /api/* {
		reverse_proxy 127.0.0.1:8787
	}
	handle /healthz {
		reverse_proxy 127.0.0.1:8787
	}

	# The join page and the downloadable app. Populated in plan 03; an empty
	# directory here is correct, not a placeholder.
	handle {
		root * /srv/layup/public
		file_server
	}

	log {
		output file /var/log/caddy/layup.log
	}
}
```

- [ ] **Step 2: Write the systemd unit**

`deploy/vm/layup-control.service`. It runs as an unprivileged user with the filesystem locked down, because this process is on the public internet.

```ini
[Unit]
Description=Layup control plane
Documentation=https://github.com/layup-app/layup
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=layup
Group=layup
EnvironmentFile=/etc/layup/control.env
ExecStart=/usr/local/bin/layup-control
Restart=on-failure
RestartSec=2

# The control plane needs no privilege beyond a loopback socket.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
# Plan 02 persists the identity store here. Creating it now costs nothing.
StateDirectory=layup

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Write the coturn configuration**

`deploy/vm/turnserver.conf`. Because the public address sits directly on `eth0`, `external-ip` equals `listening-ip` and no translation is needed — this is the case that usually goes wrong and here does not.

```conf
listening-port=3478
listening-ip=157.20.113.124
external-ip=157.20.113.124
realm=layup.blah.au

# Matches the REST credentials the control service derives from the same
# secret (ARCHITECTURE.md §9). Replaced by bootstrap.sh from control.env.
use-auth-secret
static-auth-secret=REPLACE_ME

fingerprint
min-port=49160
max-port=49200

no-cli
no-tlsv1
no-tlsv1_1
# Relay only; never let coturn become an open proxy into the host.
no-multicast-peers
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

simple-log
log-file=/var/log/turnserver.log
```

- [ ] **Step 4: Write the firewall rules**

`deploy/vm/nftables.conf`.

```nft
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
	chain input {
		type filter hook input priority 0; policy drop;

		ct state established,related accept
		ct state invalid drop
		iif lo accept
		ip protocol icmp accept
		ip6 nexthdr ipv6-icmp accept

		tcp dport 22 accept comment "ssh"
		tcp dport 443 accept comment "caddy"
		tcp dport 3478 accept comment "turn tcp fallback"
		udp dport 3478 accept comment "turn"
		udp dport 49160-49200 accept comment "turn relay range"
	}
	chain forward {
		type filter hook forward priority 0; policy drop;
	}
	chain output {
		type filter hook output priority 0; policy accept;
	}
}
```

- [ ] **Step 5: Write the environment template**

`deploy/vm/control.env.example`. The real file lives at `/etc/layup/control.env` on the VM, mode 0640, and is never committed.

```sh
LAYUP_LISTEN_ADDR=127.0.0.1:8787
LAYUP_ENV=dev
LAYUP_LOG_LEVEL=info
LAYUP_LOG_FORMAT=json

# openssl rand -hex 32 - shared with coturn's static-auth-secret.
LAYUP_TURN_SECRET=REPLACE_ME

LAYUP_TURN_URLS=turn:layup.blah.au:3478?transport=udp
LAYUP_STUN_URLS=stun:layup.blah.au:3478

# Set true only to prove the relay path end to end.
LAYUP_FORCE_RELAY=false
```

- [ ] **Step 6: Write the bootstrap script**

`deploy/vm/bootstrap.sh`. Idempotent: it is run on a fresh box and again after any config change.

```bash
#!/usr/bin/env bash
# Provisions the Layup dev VM. Safe to re-run.
#
#   scp -r deploy/vm root@157.20.113.124:/tmp/layup-vm
#   ssh root@157.20.113.124 'bash /tmp/layup-vm/bootstrap.sh'
set -euo pipefail

ASSETS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f /etc/layup/control.env ]; then
  echo "FATAL: /etc/layup/control.env is missing." >&2
  echo "Create it from control.env.example with a real LAYUP_TURN_SECRET first." >&2
  exit 1
fi

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg coturn nftables

if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  echo "==> caddy repository"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
fi
apt-get install -y -qq caddy

echo "==> service account and directories"
id -u layup >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin layup
install -d -o layup -g layup -m 0750 /var/lib/layup
install -d -m 0755 /srv/layup/public
install -d -m 0755 /var/log/caddy
chown -R caddy:caddy /var/log/caddy
chmod 0640 /etc/layup/control.env
chown root:layup /etc/layup/control.env

echo "==> coturn"
# coturn and the control service must agree on the secret; read it from the
# one file that holds it rather than duplicating it by hand.
TURN_SECRET="$(grep -E '^LAYUP_TURN_SECRET=' /etc/layup/control.env | cut -d= -f2-)"
if [ -z "$TURN_SECRET" ] || [ "$TURN_SECRET" = "REPLACE_ME" ]; then
  echo "FATAL: LAYUP_TURN_SECRET is unset or still REPLACE_ME." >&2
  exit 1
fi
sed "s|^static-auth-secret=.*|static-auth-secret=${TURN_SECRET}|" \
  "$ASSETS/turnserver.conf" > /etc/turnserver.conf
chmod 0640 /etc/turnserver.conf
# Debian ships coturn disabled until this is set.
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

echo "==> caddy"
install -m 0644 "$ASSETS/Caddyfile" /etc/caddy/Caddyfile

echo "==> control service unit"
install -m 0644 "$ASSETS/layup-control.service" /etc/systemd/system/layup-control.service
systemctl daemon-reload

echo "==> firewall"
install -m 0644 "$ASSETS/nftables.conf" /etc/nftables.conf
systemctl enable nftables

echo "==> start"
systemctl enable --now coturn caddy
systemctl restart coturn caddy
# layup-control only starts once a binary has been shipped by `make deploy`.
if [ -x /usr/local/bin/layup-control ]; then
  systemctl enable --now layup-control
  systemctl restart layup-control
else
  echo "note: /usr/local/bin/layup-control not present yet - run 'make deploy'"
fi

echo "bootstrap OK"
```

- [ ] **Step 7: Write the operator README**

`deploy/vm/README.md` must state: the first run requires creating `/etc/layup/control.env` by hand from the example with a generated secret; the firewall is applied by `systemctl start nftables` and **will not lock out ssh** because port 22 is in the allow-list; and that `make deploy` ships the binary while `bootstrap.sh` ships the configuration. Include the exact first-run sequence:

```bash
openssl rand -hex 32                      # keep this
ssh root@157.20.113.124 'mkdir -p /etc/layup'
scp deploy/vm/control.env.example root@157.20.113.124:/etc/layup/control.env
ssh root@157.20.113.124 'vi /etc/layup/control.env'   # paste the secret
scp -r deploy/vm root@157.20.113.124:/tmp/layup-vm
ssh root@157.20.113.124 'bash /tmp/layup-vm/bootstrap.sh'
```

- [ ] **Step 8: Verify the scripts are syntactically sound before they touch the server**

```bash
bash -n deploy/vm/bootstrap.sh && echo "bootstrap.sh parses"
```

Expected: `bootstrap.sh parses`. A syntax error found on the server costs a round trip; found here it costs nothing.

- [ ] **Step 9: Commit**

```bash
git add deploy/vm
git commit -m "deploy: the dev VM, as files rather than remembered commands"
```

---

### Task 2: Ship the control service and reach it over TLS

**Files:**
- Modify: `Makefile` (add `deploy-build`, `deploy`, `deploy-status`, `deploy-logs`)
- Create: `test/network/remote-health.mjs`

**Interfaces:**
- Consumes: `deploy/vm/*` from Task 1.
- Produces: `make deploy` (builds, uploads, restarts) and `node test/network/remote-health.mjs`, which Tasks 4 and 5 re-run as a regression check. Honours `LAYUP_DEPLOY_HOST` and `LAYUP_DEPLOY_DOMAIN`.

- [ ] **Step 1: Write the failing check**

`test/network/remote-health.mjs`. It proves both things Caddy has to do: plain HTTPS, and a WebSocket upgrade — which is the one most likely to be misconfigured and the one nothing else would catch until two desktops mysteriously never see each other.

```javascript
#!/usr/bin/env node
/**
 * Proves the deployed control plane is reachable the way the desktop needs it.
 *
 *   node test/network/remote-health.mjs
 *
 * Two assertions, because they fail independently: TLS-terminated HTTP, and a
 * WebSocket upgrade proxied through Caddy. A reverse proxy that serves JSON
 * happily while silently refusing the upgrade looks healthy and is useless.
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

const fail = (message) => {
  console.error(`REMOTE HEALTH FAILED: ${message}`);
  process.exit(1);
};

// 1. HTTPS through Caddy to the control service.
const health = await fetch(`https://${domain}/healthz`).catch((error) => fail(`GET /healthz: ${error.message}`));
if (!health.ok) fail(`GET /healthz returned ${health.status}`);
const body = await health.json();
if (body.status !== 'ok') fail(`/healthz status is ${JSON.stringify(body.status)}, expected "ok"`);
console.log(`healthz ok - protocol ${body.protocolVersion ?? '?'}, build ${body.build?.revision ?? '?'}`);

// 2. The WebSocket upgrade, with the same handshake the desktop sends.
const url = `wss://${domain}/api/realtime?protocolVersion=${PROTOCOL_VERSION}&devUser=${devUser}`;
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node test/network/remote-health.mjs
```

Expected: FAIL on `GET /healthz` — nothing is deployed yet. This is the red state.

- [ ] **Step 3: Add the deploy targets to the Makefile**

Append to `Makefile`, keeping the `## ` comment style so `make help` picks them up.

```makefile
LAYUP_DEPLOY_HOST ?= root@157.20.113.124
LAYUP_DEPLOY_DOMAIN ?= layup.blah.au
export LAYUP_DEPLOY_DOMAIN

.PHONY: deploy-build
deploy-build: ## Cross-compile the control service for the dev VM
	cd $(CONTROL_DIR) && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
		go build -trimpath -o ../../dist/layup-control ./cmd/control

.PHONY: deploy
deploy: deploy-build ## Ship the control service to the dev VM and restart it
	scp dist/layup-control $(LAYUP_DEPLOY_HOST):/usr/local/bin/layup-control.new
	ssh $(LAYUP_DEPLOY_HOST) 'install -m 0755 /usr/local/bin/layup-control.new /usr/local/bin/layup-control \
		&& rm -f /usr/local/bin/layup-control.new \
		&& systemctl enable --now layup-control \
		&& systemctl restart layup-control'
	@echo "deployed; verifying"
	@node test/network/remote-health.mjs

.PHONY: deploy-config
deploy-config: ## Ship deploy/vm configuration and re-run bootstrap
	scp -r deploy/vm $(LAYUP_DEPLOY_HOST):/tmp/layup-vm
	ssh $(LAYUP_DEPLOY_HOST) 'bash /tmp/layup-vm/bootstrap.sh'

.PHONY: deploy-status
deploy-status: ## Show service state on the dev VM
	ssh $(LAYUP_DEPLOY_HOST) 'systemctl --no-pager --lines=0 status layup-control caddy coturn nftables || true'

.PHONY: deploy-logs
deploy-logs: ## Tail the control service log on the dev VM
	ssh $(LAYUP_DEPLOY_HOST) 'journalctl -u layup-control -n 100 -f'
```

- [ ] **Step 4: Provision the VM**

Follow `deploy/vm/README.md` exactly: generate the secret, create `/etc/layup/control.env`, then `make deploy-config`.

Expected: `bootstrap OK`, and `make deploy-status` shows `caddy` and `coturn` active, `layup-control` inactive (no binary yet).

- [ ] **Step 5: Deploy and verify**

```bash
make deploy
```

Expected: the scp and restart succeed, then `healthz ok`, `realtime upgrade ok`, `REMOTE HEALTH OK`.

If TLS fails, check `journalctl -u caddy` for the ACME challenge — Caddy needs port 80 reachable for HTTP-01. **If it is blocked, add `tcp dport 80 accept` to `nftables.conf` and re-run `make deploy-config`.** The firewall is not applied until Task 5, so on the first pass this should succeed regardless.

- [ ] **Step 6: Commit**

```bash
git add Makefile test/network/remote-health.mjs
git commit -m "deploy: one command to ship the control plane, and a check that it arrived"
```

---

### Task 3: Prove the relay path against the deployed coturn

The single-machine container test proves coturn works. It does not prove *this* coturn, on *this* host, with *this* secret, is reachable and relaying.

**Files:**
- Create: `test/network/turn-remote.mjs`
- Modify: `Makefile` (add `test-turn-remote`)
- Modify: `test/network/README.md`

**Interfaces:**
- Consumes: `make deploy` from Task 2; the deployed `/api/turn` endpoint.
- Produces: `make test-turn-remote`, re-run as a regression check in Task 5.

- [ ] **Step 1: Write the failing check**

`test/network/turn-remote.mjs`. It deliberately fetches credentials from the deployed `/api/turn` rather than deriving them locally — that proves the control service and coturn agree about the secret, which is the failure this test exists to catch.

```javascript
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
 * It reuses the same Electron harness and the same three environment
 * variables, so the scenario being run is identical - only the TURN server
 * differs.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(repoRoot, 'apps', 'desktop');
const domain = process.env.LAYUP_DEPLOY_DOMAIN || 'layup.blah.au';
const devUser = process.env.LAYUP_DEV_USER || 'nick';

const response = await fetch(`https://${domain}/api/turn`, {
  headers: { 'X-Layup-Protocol-Version': '1', 'X-Layup-Dev-User': devUser },
});
if (!response.ok) {
  console.error(`GET /api/turn returned ${response.status}`);
  process.exit(1);
}
const envelope = await response.json();
const turn = (envelope.data?.iceServers ?? envelope.iceServers ?? []).find((server) =>
  [].concat(server.urls).some((url) => String(url).startsWith('turn:')),
);
if (!turn) {
  console.error('the control service issued no TURN server; check LAYUP_TURN_URLS and LAYUP_TURN_SECRET');
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
```

- [ ] **Step 2: Run it and confirm the failure mode is real**

```bash
node test/network/turn-remote.mjs
```

Expected before coturn is reachable: either a non-200 from `/api/turn`, or the Electron harness reporting that the relay scenario did not connect. Either is the red state.

- [ ] **Step 3: Add the Makefile target**

```makefile
.PHONY: test-turn-remote
test-turn-remote: ## Prove forced relay through the deployed coturn
	node test/network/turn-remote.mjs
```

- [ ] **Step 4: Run it green**

```bash
make test-turn-remote
```

Expected: `route: "relay"`, `relayed: true`, relay candidates at both ends, then `TURN REMOTE OK`.

If it gathers no relay candidates, the usual causes in order: `TURNSERVER_ENABLED=1` missing from `/etc/default/coturn`; the secret in `/etc/turnserver.conf` not matching `/etc/layup/control.env`; or the relay port range not reachable. `ssh root@157.20.113.124 'tail -50 /var/log/turnserver.log'` shows which.

- [ ] **Step 5: Record it in the network README**

Add `make test-turn-remote` to the table in `test/network/README.md` as the deployed counterpart of `make test-turn`, and note that it needs `make deploy` to have run.

- [ ] **Step 6: Commit**

```bash
git add test/network/turn-remote.mjs test/network/README.md Makefile
git commit -m "deploy: prove the relay path through the coturn we actually run"
```

---

### Task 4: Close the firewall

Applied last, deliberately: every check above must be green *before* we start dropping packets, so that if something breaks we know the firewall did it.

**Files:**
- Modify: `deploy/vm/README.md`

**Interfaces:**
- Consumes: verified deployment from Tasks 2 and 3.
- Produces: a host with a default-drop input policy.

- [ ] **Step 1: Confirm the control service is currently exposed**

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://157.20.113.124:8787/healthz
```

Expected: `200`. This is the hole we are closing — the control service answering directly, bypassing TLS entirely.

- [ ] **Step 2: Apply the rules**

```bash
ssh root@157.20.113.124 'systemctl restart nftables && nft list ruleset | head -30'
```

Expected: the ruleset from `deploy/vm/nftables.conf`, and the ssh session survives — port 22 is in the allow-list.

- [ ] **Step 3: Confirm the hole is closed**

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://157.20.113.124:8787/healthz || echo "refused/timed out - correct"
```

Expected: a timeout or refusal, **not** `200`.

- [ ] **Step 4: Confirm nothing else broke**

```bash
node test/network/remote-health.mjs && make test-turn-remote
```

Expected: `REMOTE HEALTH OK` and `TURN REMOTE OK`. If TLS renewal later fails, port 80 is the cause — add `tcp dport 80 accept` and re-run `make deploy-config`.

- [ ] **Step 5: Document the outcome**

In `deploy/vm/README.md`, record that the firewall is applied by `systemctl restart nftables`, that it is deliberately applied after verification rather than before, and the exact `curl` that proves 8787 is no longer reachable from outside.

- [ ] **Step 6: Commit**

```bash
git add deploy/vm/README.md
git commit -m "deploy: default drop, after proving the thing works with it open"
```

---

## Done when

- `node test/network/remote-health.mjs` prints `REMOTE HEALTH OK`.
- `make test-turn-remote` prints `TURN REMOTE OK` with `route: "relay"`.
- `curl http://157.20.113.124:8787/healthz` from outside does not answer.
- `make deploy` is the only command needed to ship a new control service build.
- `make check` is still green — no application code was touched.
