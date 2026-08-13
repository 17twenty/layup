# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0104
- completed: 11
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0103 creator privilege devolution invariant
- result: done
- tests: `go test ./internal/domain/...` ok (16 cases incl. 6 devolution regressions), `make fmt-check` clean
- evidence:
  - `services/control/internal/domain/creator.go` is the single place that answers "who, if
    anyone, holds creator authority": `CreatorMembership`, `RequireCreator(layup, MembershipID)`
    and `AuthorityOf`. There is deliberately no UserID-based overload, no host election and no
    reassignment path
  - regression tests, one per statement of the invariant (`creator_test.go`):
    creator holds authority while active; leaving elects nobody (all remaining memberships get
    `ErrForbidden`); the layup stays active and usable; the same user rejoining gets a new
    membership id with no privilege and authority does not reappear
  - the historical `Membership.IsCreatorMembership` flag is kept for audit but can never grant
    anything: views and authorisation read the layup pointer
    (`TestStoredCreatorFlagCannotGrantAuthorityAfterDevolution`)

## Recent runs

- P1-0007 done - desktop-to-control smoke path
- P1-0008 done - latency benchmark harness skeleton
- P1-0101 done - domain IDs and core types
- P1-0102 done - layup lifecycle service
- P1-0103 done - creator privilege devolution invariant

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
