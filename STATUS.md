# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Plan sequence

```text
PLAN-1   (executable now)      -> PLAN-1 GATE READY   -> humans complete PLAN-1-REVIEW.md
PLAN-1.5 (locked until then)   -> PLAN-1.5 GATE READY -> stop; PLAN-2 is not written yet
```

PLAN-1.5 supersedes two things PLAN-1 already shipped, by design (PLAN-1.5 §13):
P1-0107's organisation-wide presence fan-out becomes accepted-People-scoped, and
P1-0108's directory-backed People grid becomes connection-backed. P15-0113 also
replaces P1-0603's end-to-end flow. Remaining PLAN-1 work therefore does not
deepen the organisation-wide presence assumption, and P1-0603 stays minimal
because it is rewritten in PLAN-1.5.

`python3 scripts/ralph.py` reports which plan is live and what is next.

## Current state

- next task: P1-0406
- completed: 44 of 68 (phases A, B and C complete; D in progress)
- blocked: 1 (P1-0312 - needs two real machines; see Blocked below)
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: P1-0405 participant cursor identity
- result: done
- tests: `npm test` (214 passed incl. 6 identity cases), typecheck/lint green
- evidence:
  - identity is keyed on **membership, not user**, which is what stops a rejoining person from
    inheriting a previous cursor: a rejoin is a new membership, so it gets a clean colour,
    position and sequence (`does not reuse stale cursor state when the same person rejoins`,
    driven through the real receiver)
  - participants are distinguishable by a distinct colour *and* their name - colour is never
    the only signal
  - a departed membership is retired promptly and removed from the book, and its cursor is
    removed from the receiver; a freed colour is reused rather than drifting through the palette
  - your own cursor is excluded: you already have a real pointer
  - an unknown membership renders as "Someone" rather than a blank cursor

## Recent runs

- P1-0401 done - WebRTC data-channel abstraction
- P1-0402 done - normalised cursor protocol
- P1-0403 done - cursor sender coalescing
- P1-0404 done - remote cursor overlay and interpolation
- P1-0405 done - participant cursor identity

## Evidence index

| Claim | Command | Artefact |
|---|---|---|
| Renderer has no Node/OS privilege | `make test-boundary` | `BOUNDARY OK` |
| Real WebRTC connects and carries video | `make test-webrtc` | `WEBRTC OK` + route diagnostics |
| Creator authority devolves to nobody | `make test-e2e` | `test/e2e/creator-devolution.test.mjs` |
| Click -> accept -> one shared layup | `make test-e2e` | `test/e2e/invite-flow.test.mjs` |
| Two clients see each other without polling | `make test-smoke` | `src/core/presence.smoke.test.ts` |
| Latency harness and schema | `make bench` | `benchmarks/results/**.json` |

## Blocked

```text
BLOCKED: P1-0312
Reason:
  Acceptance requires first real-machine benchmark results on three paths (LAN,
  ordinary NAT, forced TURN). Containerisation closed part of this: the relay
  path is now genuinely verified against a real coturn on one machine. What is
  still impossible here is a second endpoint - LAN and ordinary-NAT numbers, and
  any latency figure that means anything, need two physical machines.
Evidence:
  - the harness and schema exist and run: `make bench` writes
    benchmarks/results/<scenario>/<timestamp>.json with percentiles, budgets and
    environment metadata
  - the media path is proven working, single-machine: `make test-webrtc` reports
    a real decoded 320x240 screen share, route "direct", RTT 1ms
  - the forced-relay switch is proven both ways, single-machine: relay-only
    gathers zero host candidates and does not connect without TURN, and
    `make test-turn` connects *through* a containerised coturn with
    `route: "relay"`, `relayed: true`, relay candidates at both ends
  - the procedure for the three paths is written down in test/network/README.md
Smallest human decision needed:
  Who runs the two-machine benchmark pass, and on which pair of machines?
Options:
  a) A human runs `make bench` plus the test/network/README.md procedure on two
     real machines (LAN, then ordinary NAT; the TURN path is already covered by
     `make test-turn`) and commits the result files. P1-0312 then closes on real
     evidence.
  b) Narrow P1-0312's acceptance to single-machine baselines now and re-open the
     real-machine numbers as part of the P1-0604 soak, which needs two machines
     anyway.
  c) Defer both to the PLAN-1 gate and accept that Phase D closes without
     network evidence - not recommended: SPEC §16 budgets would go unverified.
```

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- **Owed by humans, not producible here:** the multi-machine evidence in P1-0312 (LAN,
  ordinary NAT, forced TURN between two real machines) and the one-hour pairing soak in
  P1-0604. The harnesses will be built and run single-machine; the real-machine numbers must
  be collected before the PLAN-1 gate.
- PLAN-2 is not written until the human gate.
