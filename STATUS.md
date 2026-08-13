# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0007
- completed: 6
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0006 CI build and test matrix
- result: done
- tests: `make fmt-check`, cross-builds (windows/linux), `validate_tasks.py` OK: 68 tasks
- evidence:
  - `.github/workflows/ci.yml` jobs: `tasks` (validates TASKS.yaml), `go` (gofmt, vet, test,
    build), `go-cross` (linux/amd64, darwin/arm64, windows/amd64), `desktop`
    (ubuntu+macos+windows: typecheck, lint, unit tests, bundle build, artefact upload),
    `boundary` (xvfb + real Electron window renderer-privilege proof)
  - local equivalent `make ci` = validate-tasks + fmt-check + typecheck + lint + test + build
  - verified locally: `make fmt-check` clean, cross-builds for windows/amd64 and linux/amd64
    succeed from macOS, `scripts/validate_tasks.py` reports 68 valid PLAN-1 tasks

## Recent runs

- P1-0002 done - hardened Electron boundary, validated IPC, real-window boundary proof.
- P1-0003 done - control service health and config
- P1-0004 done - shared protocol version contract
- P1-0005 done - structured logging baseline
- P1-0006 done - CI build and test matrix

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
