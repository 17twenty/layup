# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0307
- completed: 34 of 68 (phases A, B and C complete; D in progress)
- blocked: 0
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: repository cleanup (no task consumed)
- result: done
- tests: `make verify` green - 142 unit tests, 6 Go packages, 13 smoke, 4 e2e scenarios,
  BOUNDARY OK, WEBRTC OK
- evidence:
  - read `docs/adr/0001`-`0008` and checked the build against them: no drift. 0001 Electron
    first, 0002 Go control plane never in the media path, 0003 P2P + coturn (never implemented
    ourselves) and 0004 membership-scoped creator are all honoured and covered by tests;
    0005/0006/0007/0008 govern work not yet started and nothing built contradicts them
  - removed dead code: `config.ErrNotConfigured`, `Hub.UsersOnline`, `Conn.LastAckSeq` and its
    state, the unused `onRealtimeReady` hook, `RequestService`'s unused layup dependency,
    `eventNames`, `isStringOfLength`, `isLiteral`, and six needlessly exported shapes
  - removed `.gitkeep` from directories that now hold real code; kept them where the directory
    is still a placeholder (`native/input-helper`, `test/network`)
  - README now describes the repository that exists (it referenced `AGENTS.md` and `PLAN-2.md`,
    neither of which is in this repo) and points at the evidence harnesses
  - `make verify` groups every real-boundary proof; `make ci` mirrors the fast CI jobs

## Recent runs

- P1-0303 done - WebRTC signalling protocol
- P1-0304 done - direct 1:1 WebRTC peer connection
- P1-0305 done - trickle ICE and route diagnostics
- P1-0306 done - coturn configuration and ephemeral credentials
- cleanup - ADR conformance check, dead code removal, docs corrected

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
