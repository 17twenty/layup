# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0208
- completed: 25
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0207 link-join layups
- result: done
- tests: `make test-go` (4 link cases), typecheck/lint/fmt green, `npm test` (100 passed)
- evidence:
  - invitation links are opaque 128-bit random tokens mapped server-side to a layup: nothing
    about the layup can be recovered from a token and it cannot be forged by editing a field
    (`TestLinkTokensRevealNothing` asserts the token contains no id, title or organisation)
  - `POST /api/layups/{id}/link` (participants only, 403 otherwise) and
    `POST /api/links/{token}/join` - a valid link joins the intended layup as an ordinary
    membership (`TestAValidLinkJoinsTheIntendedLayup`)
  - invalid, unknown and ended-layup links all fail the same way (410 with "ask for a new one"),
    so a link is not an oracle for which layups exist
  - links never cross the organisation boundary, and are refused entirely when policy
    disallows link layups
  - desktop: `layup:link` / `layup:joinLink` IPC on top of the control client

## Recent runs

- P1-0203 done - invite person into existing layup
- P1-0204 done - knock on private layup
- P1-0205 done - collapse, cancel and expire requests
- P1-0206 done - organisation-open layups and Happening Now
- P1-0207 done - link-join layups

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
