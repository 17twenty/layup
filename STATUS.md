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

- next task: P1-0513
- completed: 59 of 68 (phases A, B and C complete; D in progress)
- blocked: 1 (P1-0312 - needs two real machines; see Blocked below)
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: P1-0512 local-input priority and stuck-input cleanup
- result: done
- tests: `npm test` 324 passed (291 desktop + 33 protocol), `make check` green
- evidence:
  - **the rule, written down**: local input wins, immediately and without asking. The
    presenter touching their machine ends every remote lease, releases everything held, and
    refuses remote actions for a short window afterwards - long enough that their own drag or
    sentence is not fought over halfway through, short enough that control resumes without a
    negotiation
  - the detector is deliberately narrow, and honest about it: it watches for the OS pointer
    being somewhere this application did not put it. **It does not watch the keyboard.**
    Reading global key events to detect typing would mean watching everything the presenter
    types, which is exactly what this product must never do (SPEC.md §13.4) - typing is covered
    by the explicit emergency revoke in P1-0513, which is a deliberate action rather than an
    inference drawn from keystrokes
  - it fires once per real movement, not repeatedly while the pointer sits still, or control
    could never resume; a pixel of drift from display scaling is not a person; and polling only
    runs while somebody actually holds control, so an idle layup costs nothing
  - a disconnect releases **every** tracked key and button for that membership: keys first, in
    reverse press order, then buttons - a modifier held over a drag comes up before the drag
    ends rather than after it
  - helper crash/restart: the held state is **forgotten, not replayed**. The old process
    released everything when it died; posting releases into the new one would be a lie about
    what it is holding, and could interfere with the presenter's own input. The Go helper
    releases on every disconnect by construction (`defer injector.ReleaseAll()`), which is as
    far as this platform lets the path be proven without a second machine

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
- P1-0508 done - presenter remote-control grants
- P1-0509 done - remote click and wheel path
- P1-0510 done - pointer drag lease
- P1-0511 done - keyboard focus lease
- P1-0512 done - local-input priority and stuck-input cleanup

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
| A synthetic cursor never moves the OS pointer | `npm test` | `src/main/remote-input.test.ts` |
| Local input preempts remote control | `npm test` | `src/main/local-input-priority.test.ts` |

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
