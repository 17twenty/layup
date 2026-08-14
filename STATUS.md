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

- next task: P1-0601
- completed: 61 of 68 (phase F complete) (phases A, B and C complete; D in progress)
- blocked: 1 (P1-0312 - needs two real machines; see Blocked below)
- one command proves the lot: `make verify` (check + smoke + e2e + boundary + WebRTC)

## Last run

- task: P1-0514 editor remote-control integration test
- result: done
- tests: `make test-e2e` 8 passed (including the new `remote-editor.test.mjs`), `make check` green
- evidence:
  - one scenario end to end: grant, click into an editor, type, select by dragging, scroll, use
    Cmd+A, then emergency-revoke and prove the editor stops changing
  - **everything this project owns is real in that test** - the guest's sender, the JSON on the
    wire, the presenter's guard, the pointer and keyboard leases and the injection router are
    the actual modules, imported rather than reimplemented. A test that reimplements what it is
    testing proves only that the test agrees with itself
  - `scripts/node-ts-hook.mjs` is what makes that possible from a plain `node --test` file: it
    resolves `@layup/protocol` to the built binding and retries bundler-style relative imports
    as `.ts`. Two gaps, nothing else
  - the editor is a **model**, and the test says so: driving a real editor needs OS injection,
    which needs an Accessibility grant no unattended runner has
  - the second half closes as much of that gap as this machine allows: the same command stream
    goes to the **real helper binary** over a real socket with real HMAC authentication. Where
    the platform permits injection every command is injected; where it does not, the helper
    refuses with `not_permitted` and an actionable explanation, which the test prints. A
    malformed command is refused either way
  - a drag turns out to be a press and a release with coordinates, not a stream of moves: there
    is no `pointer.move` message, because cursor movement is an overlay that must never move
    the OS pointer. The platform layer posts the reposition as a drag event while a button is
    held (macOS `kCGEventLeftMouseDragged`)

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
- P1-0513 done - emergency revoke
- P1-0514 done - editor remote-control integration test

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
| One action stops all remote control | `npm test` | `src/main/emergency-revoke.test.ts` |
| A remote participant can drive an editor | `make test-e2e` | `test/e2e/remote-editor.test.mjs` |

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
  message is the one a person actually sees; and one macOS pass with the Accessibility grant
  driving a *real* editor, which `test/e2e/remote-editor.test.mjs` models but cannot perform
  unattended (`LAYUP_ALLOW_REAL_INPUT=1 go test ./internal/inject` is the opt-in half that a
  human with the grant can run today).
- PLAN-2 is not written until the human gate.
