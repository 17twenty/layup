# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0306
- completed: 33
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0305 trickle ICE and route diagnostics
- result: done
- tests: `npm test` (142 passed incl. 5 diagnostics cases), `make test-webrtc` -> WEBRTC OK with route diagnostics
- evidence:
  - trickle ICE was already in the peer module (candidates relayed as discovered, end-of-
    candidates not relayed); this task adds the diagnostics that make a connection explainable
  - `apps/desktop/src/core/ice-diagnostics.ts` classifies the *selected* candidate pair as
    direct / reflexive / relay / unknown, with candidate types, transport, RTT, available
    outgoing bitrate and byte counters; `describeRoute` gives the UI a plain phrase
  - handles both ways browsers expose the selected pair (transport.selectedCandidatePairId and
    a succeeded pair) and says "unknown" rather than guessing (5 unit tests)
  - `peer.diagnostics()` reads it from live stats, and the real Electron harness now reports
    through the production module: `route: "direct", relayed: false, localCandidateType: "host",
    remoteCandidateType: "host", rttMs: 0, bytesSent: 1758`

## Recent runs

- P1-0301 done - enumerate and preview capture sources
- P1-0302 done - capture permission onboarding
- P1-0303 done - WebRTC signalling protocol
- P1-0304 done - direct 1:1 WebRTC peer connection
- P1-0305 done - trickle ICE and route diagnostics

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
