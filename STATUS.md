# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0103
- completed: 10
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0102 layup lifecycle service
- result: done
- tests: `go test ./internal/domain/...` ok (10 lifecycle cases), `make fmt-check` clean
- evidence:
  - `services/control/internal/domain/repository.go` - `Repository` interface plus a
    concurrent-safe `MemoryRepository` (PLAN-1 in-memory only; persistence must implement the
    same interface rather than reshape the domain)
  - `layups.go` - `LayupService.CreateLayup/Join/Leave/View/ActiveLayupsForUser`
  - proven: first membership activates the layup; layup survives while any membership remains;
    the final leave stamps `EndedAt`; an ownerless layup still accepts joins
    (`TestFirstMembershipActivatesLayup`, `TestLayupRemainsActiveWhileAnyMembershipRemains`,
    `TestFinalMembershipLeavingEndsLayup`, `TestNoOwnerRequirementForAnActiveLayup`)
  - join is idempotent for a present user, joining an ended layup is `ErrConflict`, leaving
    twice is a no-op

## Recent runs

- P1-0006 done - CI build and test matrix
- P1-0007 done - desktop-to-control smoke path
- P1-0008 done - latency benchmark harness skeleton
- P1-0101 done - domain IDs and core types
- P1-0102 done - layup lifecycle service

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
