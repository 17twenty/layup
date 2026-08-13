# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0308
- completed: 35 of 68 (phases A, B and C complete; D in progress)
- blocked: 0
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: P1-0307 forced TURN test mode
- result: done
- tests: `npm test` (148 passed incl. 6 ICE cases), `make test-webrtc` -> WEBRTC OK with both scenarios, boundary OK
- evidence:
  - two independent switches, both surfaced as `forcedBy`: `LAYUP_FORCE_RELAY` on the control
    service (organisation policy, sent to every client) and on a desktop (that client only)
  - `apps/desktop/src/main/ice.ts` fetches ICE servers + short-lived TURN credentials, caches
    them until they are close to expiring, and keeps forcing relay even when the control plane
    is unreachable - failing loudly beats quietly going direct (6 unit tests)
  - deterministic proof that the mode is real (`make test-webrtc`, second scenario):
    `{iceTransportPolicy: "relay", connected: false, hostCandidatesGathered: 0}` - with no TURN
    reachable, relay-only gathers no host candidates and does not connect. If `forceRelay` were
    ignored these peers would connect exactly like the direct scenario, so this is the guard
    that stops a relay test passing vacuously
  - the direct scenario still reports `route: "direct", relayed: false, rttMs: 1`
  - `test/network/README.md` documents both switches, the automated halves, and the compose
    procedure for verifying a real relayed session (pass condition: `route: "relay"`,
    `relayed: true`, `forcedBy: "policy"`)
  - the redaction rule caught `hasTurnCredential` as a field name; renamed to `turnAuthIssued`
    rather than weakening the rule - the credential itself is never logged

## Recent runs

- P1-0304 done - direct 1:1 WebRTC peer connection
- P1-0305 done - trickle ICE and route diagnostics
- P1-0306 done - coturn configuration and ephemeral credentials
- cleanup - ADR conformance check, dead code removal, docs corrected
- P1-0307 done - forced TURN test mode

## Evidence index

| Claim | Command | Artefact |
|---|---|---|
| Renderer has no Node/OS privilege | `make test-boundary` | `BOUNDARY OK` |
| Real WebRTC connects and carries video | `make test-webrtc` | `WEBRTC OK` + route diagnostics |
| Creator authority devolves to nobody | `make test-e2e` | `test/e2e/creator-devolution.test.mjs` |
| Click -> accept -> one shared layup | `make test-e2e` | `test/e2e/invite-flow.test.mjs` |
| Two clients see each other without polling | `make test-smoke` | `src/core/presence.smoke.test.ts` |
| Latency harness and schema | `make bench` | `benchmarks/results/**.json` |

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is
  externally managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- **Owed by humans, not producible here:** the multi-machine evidence in P1-0312 (LAN,
  ordinary NAT, forced TURN between two real machines) and the one-hour pairing soak in
  P1-0604. The harnesses will be built and run single-machine; the real-machine numbers must
  be collected before the PLAN-1 gate.
- PLAN-2 is not written until the human gate.
