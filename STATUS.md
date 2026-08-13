# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0303
- completed: 30
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0302 capture permission onboarding
- result: done
- tests: `npm test` (127 passed incl. 8 permission cases), typecheck/lint green, boundary OK
- evidence:
  - `apps/desktop/src/main/permissions.ts` - reads macOS screen-recording status and turns each
    state into plain guidance: denied -> "Privacy & Security → Screen Recording ... then restart",
    restricted -> an administrator problem, not-determined -> approve the prompt and restart
  - Windows and Linux report `not-required` and get no invented gate; an unreadable status stays
    usable rather than blocking the person (`stays usable when the status cannot be read`)
  - `capture:openSettings` deep-links macOS to the right settings page; it is a no-op elsewhere
  - the picker shows an alert with the guidance and a settings button only when capture is
    actually blocked, and says nothing when permission is fine
  - 6 main-process tests + 2 renderer tests

## Recent runs

- P1-0208 done - incoming invitation experience
- P1-0209 done - invite while already in a layup
- P1-0210 done - menu/tray pending attention
- P1-0301 done - enumerate and preview capture sources
- P1-0302 done - capture permission onboarding

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
