# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0202
- completed: 19
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0201 join request domain and lifecycle
- result: done
- tests: `go test ./internal/domain/...` ok (9 new request cases)
- evidence:
  - `services/control/internal/domain/requests.go` - one `JoinRequest` object with
    `INVITE_USER_TO_NEW_LAYUP` / `INVITE_USER_TO_LAYUP` / `KNOCK_TO_JOIN` and states
    PENDING/ACCEPTED/DECLINED/EXPIRED/CANCELLED
  - transitions are validated: only terminal targets are accepted, and a terminal request can
    never be re-resolved (`TestTerminalStatesAreFinal` covers all 9 combinations)
  - expiry is deterministic - driven by the injected clock, resolved exactly at the deadline,
    and an expired request cannot be accepted and disappears from both sides
    (`TestExpiryIsDeterministic`)
  - duplicate collapse is in the domain, not the UI: an equivalent pending request from the
    same requester is returned instead of creating a second notification
    (`TestDuplicateRequestsCollapse`, `TestKnocksCollapseByRequesterAndLayup`)
  - shape rules enforced: invitations need a recipient, knocks need a layup, an invitation to a
    new layup must not name one, and you cannot invite yourself

## Recent runs

- P1-0107 done - presence publication and fan-out
- P1-0108 done - people home grid
- P1-0109 done - logical layup create/join/leave API
- P1-0110 done - creator devolution end-to-end test
- P1-0201 done - join request domain and lifecycle

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
