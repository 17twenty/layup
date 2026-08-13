# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0110
- completed: 17
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0109 logical layup create/join/leave API
- result: done
- tests: `make test-go` (6 layup API cases), `npm test` (94 passed), `make test-smoke` (13 passed), boundary OK
- evidence:
  - control plane: `POST /api/layups`, `GET /api/layups/{id}`, `POST /api/layups/{id}/join`,
    `POST /api/layups/{id}/leave`. Bodies reject unknown fields; ids are validated; a private
    layup 404s for outsiders (they are not told it exists) and joining one is 403
  - `layup.state` is pushed over realtime to every participant on any membership change, and
    presence/activity is republished for everyone affected
  - creator devolution is visible in API state: after the creator leaves,
    `hasCreatorAuthority=false`, `creatorMembershipId` is absent and no participant is flagged;
    a rejoin mints a new membership and restores nothing
    (`TestCreatorDevolutionIsVisibleInAPIState`)
  - you can only end your own membership - there is no endpoint to remove anyone else
  - desktop: `main/layups.ts` supervisor (8 unit tests) + `layup:current|create|join|leave`
    IPC and a `LayupPanel` that lists participants, tags creator/you, and states plainly when
    authority has devolved to nobody
  - real two-client evidence (`make test-smoke`, 13 passed): Nick creates, Karl joins the same
    layup, Nick sees the membership update over realtime; creator leaves -> layup continues
    with no authority anywhere; last participant leaving ends it; private layup invisible to
    an outsider

## Recent runs

- P1-0105 done - presence state model
- P1-0106 done - realtime WebSocket envelope
- P1-0107 done - presence publication and fan-out
- P1-0108 done - people home grid
- P1-0109 done - logical layup create/join/leave API

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
