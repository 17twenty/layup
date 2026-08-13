# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0207
- completed: 24
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0206 organisation-open layups and Happening Now
- result: done
- tests: `make test-go` (3 discovery cases), `npm test` (100 passed), typecheck/lint green
- evidence:
  - `GET /api/layups` lists only active ORGANISATION layups in the caller's organisation, with
    title, participant names, count, a presenter placeholder (Phase D fills it) and join state
  - private layups never appear - asserted on the raw response body, not just the parsed one
    (`TestHappeningNowShowsOrganisationOpenLayupsOnly`)
  - listings track reality: joining raises the count, and a layup with no active participants
    disappears rather than lingering as an empty room
  - an organisation member can join an open layup with no invitation at all
  - desktop: `HappeningNow` renders the surface and refreshes on presence/layup pushes; the
    entry you are already in says "You are here" instead of offering Join

## Recent runs

- P1-0202 done - invite available person to new layup
- P1-0203 done - invite person into existing layup
- P1-0204 done - knock on private layup
- P1-0205 done - collapse, cancel and expire requests
- P1-0206 done - organisation-open layups and Happening Now

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
