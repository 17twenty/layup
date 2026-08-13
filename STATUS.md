# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0105
- completed: 12
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0104 development user and organisation directory
- result: done
- tests: `go test ./...` ok (directory+httpapi), `npm test` (49 passed), `make test-smoke` (3), `make test-boundary` OK
- evidence:
  - `services/control/internal/directory` - deterministic dev directory: one organisation
    `org_devlayup` and four people (nick/karl/emelia/priya) with stable IDs derived from their
    handles, no passwords/tokens/provider
  - `internal/httpapi/identity.go` - `X-Layup-Dev-User` resolves against the directory;
    missing/unknown -> 401. Organisation always comes from the directory entry, never the
    request (`TestIdentityCannotChooseItsOwnOrganisation`)
  - `GET /api/me` and `GET /api/directory` (versioned + identified);
    `GET /api/protocol` stays identity-free
  - desktop: `LAYUP_DEV_USER` selects the identity, control client sends the header,
    `identity:current` IPC + renderer line "You are Karl · Layup Development · LAYUP_DEV_USER=karl";
    unresolved identity states the reason
  - `apps/desktop/README.md` documents running two clients side by side

## Recent runs

- P1-0008 done - latency benchmark harness skeleton
- P1-0101 done - domain IDs and core types
- P1-0102 done - layup lifecycle service
- P1-0103 done - creator privilege devolution invariant
- P1-0104 done - development user and organisation directory

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
