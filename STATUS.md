# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0004
- completed: 3
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0003 control service health and config
- result: done
- tests: `make test-go` (config+httpapi ok), `make lint-go`, live curl smoke
- evidence:
  - `services/control/internal/config` - env-driven config with fail-fast validation; a bad
    `LAYUP_LOG_LEVEL` exits 1 with `LAYUP_LOG_LEVEL "verbose" must be debug|info|warn|error`
  - `services/control/internal/httpapi` - `GET /healthz` -> 200 JSON
    `{status, protocolVersion, environment, uptimeSeconds, build{version,goVersion,platform}}`;
    unknown route 404, wrong method 405
  - `services/control/internal/buildinfo` - version/commit/goVersion/platform, VCS stamp aware
  - live check: `curl 127.0.0.1:8791/healthz` returned `{"status":"ok","protocolVersion":1,...}`;
    startup log is one JSON line with build + listen address and no secrets

## Recent runs

- P1-0001 done - workspace, toolchain pins, root developer commands.
- P1-0002 done - hardened Electron boundary, validated IPC, real-window boundary proof.
- P1-0003 done - control service health and config

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
