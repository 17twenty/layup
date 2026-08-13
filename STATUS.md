# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0310
- completed: 37 of 68 (phases A, B and C complete; D in progress)
- blocked: 0
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: P1-0309 single active screen-share domain
- result: done
- tests: `make test-go` (7 domain + 4 wire share cases), fmt/vet green
- evidence:
  - `services/control/internal/domain/screenshare.go` owns the rule, not the media layer: who
    may present is a domain question and holds even while a track is still negotiating
  - zero-or-one enforced: taking over ends the previous share in the same operation, and after
    three successive takeovers exactly one share is live
    (`TestOnlyOneSharedDesktopExistsAtATime`)
  - takeover rules follow SPEC §7.2: in a private/collaborative layup anyone may take the
    screen with no approval dialog, and the previous presenter gets a `screen.takeover` notice;
    in an advertised ORGANISATION layup only the creator membership or the current presenter
    may hand it over, and with nobody presenting anyone may start
  - stopping a share leaves the layup and its participants completely untouched
    (`TestStoppingAShareKeepsTheLayupAlive`) - a layup with no screen is a valid layup
  - only the presenter may stop their own share; there is no moderator who can stop someone
    else's (`TestShareControlIsNotModeration`)
  - a presenter who leaves the layup has their share ended automatically, so no phantom share
    survives (`TestAPresenterLeavingEndsTheirShare`)
  - `POST /api/layups/{id}/share` and `/share/stop`; the active share (with presenter name and
    the presenter's drawing/pointer/keyboard defaults) now rides on layup state and Happening Now

## Recent runs

- P1-0306 done - coturn configuration and ephemeral credentials
- cleanup - ADR conformance check, dead code removal, docs corrected
- P1-0307 done - forced TURN test mode
- P1-0308 done - publish and render shared desktop
- P1-0309 done - single active screen-share domain

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
