# Network path verification

Layup must work on three paths (SPEC.md §10.3), and the relay path must be
verifiable continuously rather than once by hand:

1. same-LAN direct;
2. ordinary Internet/NAT;
3. forced relay through TURN.

## What is automated

`make test-webrtc` runs both halves that do not need infrastructure:

| Scenario | What it proves |
|---|---|
| `direct` | Two production peer connections negotiate in real Chromium and carry a real video track; diagnostics report the selected route (`direct`, candidate types, RTT, bytes). |
| `forcedRelayWithoutTurn` | Forced relay genuinely changes behaviour: `iceTransportPolicy` is `relay`, **zero** host candidates are gathered and the peers do **not** connect when no TURN server is reachable. |

`make test-turn` adds the positive half against a **real coturn in a container**
(needs Docker, no second machine):

| Scenario | What it proves |
|---|---|
| `forcedRelayWithTurn` | A forced-relay session connects *through* coturn, and diagnostics report `route: "relay"`, `relayed: true` with `relay` candidates at both ends. |

> Chromium ignores a TURN server on a loopback address - it gathers no relay
> candidates and fails silently. The runner therefore starts coturn advertising
> this machine's interface address and dials that, which is why the test works
> on one machine but still exercises a real allocation.

The second scenario is the guard that matters: if `forceRelay` were quietly
ignored, a "relay" test would silently pass over host candidates and prove
nothing.

## Forcing relay

Two independent switches, both surfaced in diagnostics as `forcedBy`:

| Switch | Where | Effect |
|---|---|---|
| `LAYUP_FORCE_RELAY=true` on the control service | organisation policy | every client is told to use relay only (`forcedBy: "policy"`) |
| `LAYUP_FORCE_RELAY=true` on a desktop | that client only | that client uses relay only (`forcedBy: "local"`) |

A desktop that cannot reach the control service keeps forcing relay if its own
switch is set - it fails loudly instead of quietly going direct.

## Verifying the relay path against real TURN

`make test-turn` does this automatically with a container. The procedure below
is the two-machine version, which additionally exercises the desktop UI and real
network latency. Layup does not implement TURN (ADR-0003).

```bash
# 1. Bring up the control service and coturn.
export LAYUP_TURN_SECRET="$(openssl rand -hex 32)"
export LAYUP_TURN_HOST=<host or IP reachable by both machines>
export LAYUP_FORCE_RELAY=true
docker compose -f deploy/compose/docker-compose.yml up --build

# 2. Check the credentials the server issues (username is "<expiry>:<userId>").
curl -s -H 'X-Layup-Protocol-Version: 1' -H 'X-Layup-Dev-User: nick' \
     http://$LAYUP_TURN_HOST:8787/api/turn | jq

# 3. Run two desktops against it.
LAYUP_CONTROL_URL=http://$LAYUP_TURN_HOST:8787 LAYUP_DEV_USER=nick  npm run dev
LAYUP_CONTROL_URL=http://$LAYUP_TURN_HOST:8787 LAYUP_DEV_USER=karl  npm run dev
```

Then: Nick clicks Karl, Karl accepts, one of them shares a screen.

**Pass condition** - the connection diagnostics must report:

```text
route: "relay"          relayed: true
localCandidateType: "relay"   (or remoteCandidateType: "relay")
forcedBy: "policy"
```

A `direct` or `reflexive` route while relay is forced is a failure, not a
better outcome: it means the policy was not applied.

## Paths 1 and 2

Same-LAN and ordinary-NAT runs use the same two-desktop procedure with
`LAYUP_FORCE_RELAY` unset, on two real machines. Record the route and the
measurements from `make bench` for each path.

> Multi-machine LAN/NAT/TURN numbers cannot be produced on a single build
> machine. They are owed by a human before the PLAN-1 gate and are tracked in
> `STATUS.md`.
