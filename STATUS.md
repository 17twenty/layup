# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0006
- completed: 5
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0005 structured logging baseline
- result: done
- tests: `make test-go` (logging ok), `npm test` (30 passed), typecheck/lint green, live request-log check
- evidence:
  - Go: `services/control/internal/logging` - slog JSON handler wrapped by a redacting
    handler; correlation fields ride on the context (`WithFields`), HTTP middleware mints or
    reuses `X-Layup-Request-ID`
  - desktop: `apps/desktop/src/main/logging.ts` - one JSON object per line, `with()` child
    loggers for session/layup correlation, same redaction rule including nested fields
  - forbidden content (credentials, keystrokes, clipboard, pixels, audio/video, raw cursor
    coordinates) is redacted at handler level, proven both sides:
    `logging_test.go:TestForbiddenFieldsAreRedacted`, `logging.test.ts` redaction case
  - live: two requests to `/healthz` logged with `requestId` `516c2078...` and a
    client-supplied `demo-123`; startup line carries build + listen address, no secrets

## Recent runs

- P1-0001 done - workspace, toolchain pins, root developer commands.
- P1-0002 done - hardened Electron boundary, validated IPC, real-window boundary proof.
- P1-0003 done - control service health and config
- P1-0004 done - shared protocol version contract
- P1-0005 done - structured logging baseline

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
