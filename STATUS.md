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

- next task: P1-0508
- completed: 54 of 68 (phases A, B and C complete; D in progress)
- blocked: 1 (P1-0312 - needs two real machines; see Blocked below)
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: P1-0507 reliable remote-input protocol
- result: done
- tests: `npm test` 267 passed (234 desktop + 33 protocol), `make check` green
- evidence:
  - `protocol/ts/src/input.ts` adds the ten `input-reliable` messages from SPEC §11:
    pointer down/up/click/wheel, key down/up, control grant/revoke, lease acquire/release
  - every message carries a protocol version, and a version this build does not implement is
    **refused, not partially understood** - guessing at an unfamiliar field would mean
    guessing at what to do to somebody else's machine
  - coordinates are normalised to the shared surface, as cursors are: the sender does not
    know the presenter's display geometry and must not guess
  - a key message carries a `KeyboardEvent.code` and nothing else. Typed *content* is not a
    protocol concept: `isPlausibleKeyCode` refuses anything that is not a key name, so a
    password cannot travel as a "key"
  - `input-guard.ts` is the authority, and it trusts nothing in the message: the claimed
    membership must match the peer the message arrived on; the sender must hold a current
    grant for that scope; only the presenter's machine injects, and only while sharing; the
    grant is bound to the shared display, so stopping or switching the share ends control
    immediately; sequence numbers move forwards only, so a captured action cannot be replayed
  - **cursor-fast stays separate**: a click that arrives on the cursor channel is refused
    outright (`wrong-channel`), because that channel is designed to throw packets away
  - a participant cannot grant themselves control, and a presenter cannot grant control of
    their machine to themselves
  - refusal reasons are a fixed vocabulary and never quote the payload - a refusal that echoed
    the key would put typed content into whatever logs it
  - `input-sender.ts` sends each action exactly once, in order, never coalesced; clamps
    coordinates and wheel deltas so an action is bounded rather than dropped by the far side;
    and on revoke releases everything it was holding, in reverse press order, even though the
    grant has gone - otherwise the presenter is left holding Cmd
  - the two halves meet in a test: everything the sender produces is accepted by the guard

## Recent runs

- P1-0406 done - drawing protocol
- P1-0407 done - drawing overlay
- P1-0408 done - presenter drawing safety toggle
- P1-0501 done - native helper protocol and authentication
- P1-0502 done - native helper lifecycle
- P1-0503 done - macOS pointer injection
- P1-0504 done - macOS keyboard injection
- P1-0505 done - Windows pointer injection
- P1-0506 done - Windows keyboard injection
- P1-0507 done - reliable remote-input protocol

## Evidence index

| Claim | Command | Artefact |
|---|---|---|
| Renderer has no Node/OS privilege | `make test-boundary` | `BOUNDARY OK` |
| Real WebRTC connects and carries video | `make test-webrtc` | `WEBRTC OK` + route diagnostics |
| Creator authority devolves to nobody | `make test-e2e` | `test/e2e/creator-devolution.test.mjs` |
| Click -> accept -> one shared layup | `make test-e2e` | `test/e2e/invite-flow.test.mjs` |
| Two clients see each other without polling | `make test-smoke` | `src/core/presence.smoke.test.ts` |
| Latency harness and schema | `make bench` | `benchmarks/results/**.json` |
| Helper injects real macOS input | `LAYUP_ALLOW_REAL_INPUT=1 go test ./internal/inject` (opt-in) | `inject_darwin_test.go` |
| Bad input payloads never reach the OS | `make test-go` | `internal/commands/commands_test.go` |
| Typed content is never logged | `npm test` | `never writes typed content to its log` |
| One key vocabulary across platforms | `make test-go` | `TestBothPlatformsSpeakTheSameKeyVocabulary` |
| Remote input needs a live grant | `npm test` | `src/core/input-guard.test.ts` |

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
- The Windows helper is only cross-*compiled* here (`GOOS=windows go build ./...`), because no
  Windows machine is available and the Makefile is outside P1-0505's `allowed_paths`. Wiring
  that cross-build into `make ci` needs a task whose paths include the Makefile.
- **Owed by humans, not producible here:** a real Windows run of the pointer and keyboard
  paths, including one click aimed at an elevated window to confirm the integrity-boundary
  message is the one a person actually sees.
- PLAN-2 is not written until the human gate.
