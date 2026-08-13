# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0311
- completed: 38 of 68 (phases A, B and C complete; D in progress)
- blocked: 0
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: P1-0310 minimal camera and microphone tracks
- result: done
- tests: `npm test` (171 passed incl. 9 AV/session cases), `make test-webrtc` -> WEBRTC OK, typecheck/lint green
- evidence:
  - `apps/desktop/src/core/av.ts` opens camera and microphone *for a membership*: `start()`
    refuses without one, so clicking a person can never open the camera - media follows
    acceptance (`refuses to start without a membership`, SPEC.md §4)
  - both devices are opened once and the join policy decides what is *enabled*, so unmuting
    later never re-prompts for permission
  - muting disables the track rather than stopping it, so coming back needs no renegotiation
    (`mutes by disabling the track, not by stopping it`)
  - device failures are explained in words a person can act on: permission refused, no device,
    or already in use by another application
  - the session publishes camera+microphone to every peer and replaces tracks in place when
    devices change; incoming video is classified as the shared desktop **only** for the
    membership the control plane says is presenting, so ADR-0007 decides what a screen is
    rather than a guess about track order
  - 7 AV tests + 2 new session tests; `make test-webrtc` still WEBRTC OK end to end

## Recent runs

- cleanup - ADR conformance check, dead code removal, docs corrected
- P1-0307 done - forced TURN test mode
- P1-0308 done - publish and render shared desktop
- P1-0309 done - single active screen-share domain
- P1-0310 done - minimal camera and microphone tracks

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
