# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0008
- completed: 7
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0007 desktop-to-control smoke path
- result: done
- tests: `npm test` (46 passed), `make test-smoke` (3 passed), `make test-boundary` OK, typecheck/lint/build green
- evidence:
  - `apps/desktop/src/core/control-client.ts` - probe returns `connected` / `unreachable` /
    `incompatible` with a human-readable `detail`, bounded by a timeout so an absent server
    cannot hang the UI; versioned calls send `X-Layup-Protocol-Version`
  - `apps/desktop/src/main/control.ts` - debounces probes, logs transitions once
  - `apps/desktop/src/renderer/ControlStatus.tsx` - status line: connected shows protocol
    version, environment and latency; otherwise the reason is shown verbatim
  - smoke `make test-smoke` (3 passed): builds and runs the real Go service, asserts
    connected, asserts `/api/protocol` needs a supported header (400 without, 426 at v99),
    then kills the service and asserts the disconnected state
  - `make test-boundary` still OK; the harness caught the widened bridge surface and now
    asserts `['app','control','protocolVersion']`
  - `@layup/protocol` now ships ESM + CJS so the Electron main process can require it

## Recent runs

- P1-0003 done - control service health and config
- P1-0004 done - shared protocol version contract
- P1-0005 done - structured logging baseline
- P1-0006 done - CI build and test matrix
- P1-0007 done - desktop-to-control smoke path

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
