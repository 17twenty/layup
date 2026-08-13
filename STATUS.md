# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0312
- completed: 39 of 68 (phases A, B and C complete; D in progress)
- blocked: 0
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: P1-0311 join AV default policy
- result: done
- tests: `make test-go` (4 policy + 1 wire case), `npm test` (171 passed), lint/fmt green
- evidence:
  - `services/control/internal/domain/avpolicy.go` implements SPEC §4: joining at a resulting
    count of 1-4 gives camera ON + microphone ON; participant 5 or later gives camera ON +
    microphone MUTED, with `mutedByThreshold` so the UI can say *why* rather than looking broken
  - precedence is enforced, not assumed: personal preference may only narrow what organisation
    policy allows - a stricter preference wins, a more permissive one is ignored
    (`TestPersonalPreferenceMayOnlyNarrow`)
  - the threshold is policy, not a constant: an organisation can move it (3 mutes the third
    joiner) or disable it entirely (0 never auto-mutes)
  - every join carries the decision: `layup.created`, `layup.joined` and `request.accepted` all
    return `media {camera, microphone, participantCount, mutedByThreshold}`, so the client never
    has to re-derive it (`TestJoinMediaDefaultsRideOnEveryJoin` walks participants 1-4 over the
    wire and asserts the 5th through the same domain rule the endpoint uses)
  - the desktop threads it into layup state, and `av.ts` applies it when devices open

## Recent runs

- P1-0307 done - forced TURN test mode
- P1-0308 done - publish and render shared desktop
- P1-0309 done - single active screen-share domain
- P1-0310 done - minimal camera and microphone tracks
- P1-0311 done - join AV default policy

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
