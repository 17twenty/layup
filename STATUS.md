# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0002
- completed: 1
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0001 bootstrap repository and pin toolchains
- result: done
- tests: `npm test` (1 passed), `make build-go`, `make lint-go`, `make test-go`, `npm run typecheck`, `npm run lint`, `npm run build` - all green
- metrics: none (no budget defined)
- evidence:
  - toolchain pinned: `.tool-versions`, `mise.toml` (node 26.5.0, go 1.26.4), `packageManager: npm@11.17.0`
  - desktop: `apps/desktop` builds main/preload via tsc and renderer via Vite; `npm run dev` launches Electron
  - control: `services/control` builds; `go run ./cmd/control` prints `layup-control dev (protocol v1)`
  - protocol boundary: `protocol/VERSION`, `protocol/go`, `protocol/ts` (`@layup/protocol`)
  - root commands: `make help|check|build|test|lint|typecheck`

## Recent runs

1. P1-0001 done - workspace, toolchain pins, root developer commands.

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
