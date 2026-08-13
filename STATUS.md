# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0309
- completed: 36 of 68 (phases A, B and C complete; D in progress)
- blocked: 0
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: P1-0308 publish and render shared desktop
- result: done
- tests: `npm test` (162 passed incl. 14 session/screen cases), `make test-webrtc` -> WEBRTC OK with decoded 320x240 screen share
- evidence:
  - `apps/desktop/src/core/session.ts` owns a layup's peer connections and what is published on
    them: publish/unpublish the shared desktop, route relayed signalling to the right peer,
    render what each peer sends, and report per-peer connection state (10 unit tests)
  - exactly one shared desktop per peer (ADR-0007): re-sharing calls `replaceTrack` rather than
    adding a second sender, and a peer that joins after sharing started receives it
  - stopping the share replaces the track with null - the peer connection and the layup survive
    (`stops publishing without touching the peer connection`)
  - real proof in Chromium (`make test-webrtc`, third scenario): a captured stream is published
    through the session, arrives at the far side, and **decodes** into a video element at
    `320x240` - `{received: true, decoded: true, inbound: {width: 320, height: 240},
    route: "direct", connectedAfterUnpublish: true}`. Decoding is asserted because a track that
    arrives but never decodes is a black screen share
  - `SharedScreen` renders the presenter's stream, names them, flags a reconnecting presenter,
    and treats "nobody is sharing" as a normal state rather than an error (4 renderer tests)

## Recent runs

- P1-0305 done - trickle ICE and route diagnostics
- P1-0306 done - coturn configuration and ephemeral credentials
- cleanup - ADR conformance check, dead code removal, docs corrected
- P1-0307 done - forced TURN test mode
- P1-0308 done - publish and render shared desktop

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
