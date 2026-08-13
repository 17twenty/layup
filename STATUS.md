# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0201
- completed: 18
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0110 creator devolution end-to-end test
- result: done
- tests: `make test-e2e` (2 scenarios, 0 failures) against a freshly built control service
- evidence:
  - `test/e2e/creator-devolution.test.mjs` runs against a real control service over real HTTP
    and a real WebSocket, importing no application code - only the wire contract - so it
    catches a regression made anywhere in the server
  - asserts, in one scenario: distinct membership ids for creator and joiner; after the creator
    leaves the layup stays active with `hasCreatorAuthority=false`, no `creatorMembershipId`
    and no participant flagged; the remaining participant is pushed the same state over
    realtime; the former creator's rejoin mints a new membership id and restores nothing
  - also asserts there is no creator-claim endpoint (`POST /api/layups/{id}/creator` -> 404)
  - second case: the layup ends only when the last membership leaves, `endedAt` is stamped,
    and rejoining an ended layup is 409
  - `make test-e2e` wired into the CI smoke job

## Recent runs

- P1-0106 done - realtime WebSocket envelope
- P1-0107 done - presence publication and fan-out
- P1-0108 done - people home grid
- P1-0109 done - logical layup create/join/leave API
- P1-0110 done - creator devolution end-to-end test

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
