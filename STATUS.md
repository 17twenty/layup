# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0005
- completed: 4
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0004 shared protocol version contract
- result: done
- tests: `npm test` (24 passed), `make test-go` (protocol+httpapi ok), typecheck/lint/build green
- evidence:
  - `protocol/VERSION` is the single source of truth; both bindings assert against it
    (`protocol/go/envelope_test.go`, `protocol/ts/src/envelope.test.ts`)
  - envelope `{v,type,id?,payload?}` implemented in `protocol/go/envelope.go` and
    `protocol/ts/src/envelope.ts`; malformed input is rejected, never coerced
  - deterministic mismatch path: `/api/*` requires `X-Layup-Protocol-Version`;
    missing/garbage -> 400 `malformed_message`, unsupported -> 426
    `unsupported_protocol_version` with `{serverVersion, receivedVersion}`
  - `/healthz` deliberately stays unversioned so a mismatched client can discover the
    server version (`TestHealthzStaysReachableWithoutAVersionHeader`)
  - desktop advertises the shared version: validators now live in `@layup/protocol`,
    consumed by the IPC contract, preload bridge and renderer

## Recent runs

- P1-0001 done - workspace, toolchain pins, root developer commands.
- P1-0002 done - hardened Electron boundary, validated IPC, real-window boundary proof.
- P1-0003 done - control service health and config
- P1-0004 done - shared protocol version contract

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
