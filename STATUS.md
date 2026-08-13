# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0003
- completed: 2
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0002 harden Electron process boundary
- result: done
- tests: `npm test` (18 passed), `npm run typecheck`, `npm run lint`, `npm run build`, `make test-boundary` - all green
- metrics: none (no budget defined)
- evidence:
  - `apps/desktop/src/main/window.ts` - contextIsolation on, nodeIntegration off, sandbox on,
    webviewTag off, insecure content off; asserted by `src/main/window.test.ts`
  - `apps/desktop/src/shared/ipc.ts` - the only declared renderer->main surface, request and
    response validated in both directions
  - `apps/desktop/src/shared/validate.ts` - dependency-free validators; unknown properties are
    rejected, not ignored (`src/shared/validate.test.ts`)
  - `apps/desktop/src/preload/api.ts` - enumerated bridge, no generic invoke, bundled for a
    sandboxed preload (`vite.preload.config.ts`)
  - real-window proof `make test-boundary`: renderer sees `require/process/module/global/Buffer`
    as `undefined`, `window.layup` keys exactly `['app','protocolVersion']`, smuggled payload
    discarded -> `BOUNDARY OK`

## Recent runs

1. P1-0001 done - workspace, toolchain pins, root developer commands.
2. P1-0002 done - hardened Electron boundary, validated IPC, real-window boundary proof.

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
