# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0106
- completed: 13
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0105 presence state model
- result: done
- tests: `go test ./internal/domain/...` ok (22 cases incl. 7 presence)
- evidence:
  - `services/control/internal/domain/presence.go` - `PersonalPresence`
    (AVAILABLE/AWAY/DND/OFFLINE) and `ActivityPresence`
    (NONE/IN_PRIVATE_LAYUP/IN_OPEN_LAYUP/INVITING_YOU/WAITING_FOR_YOU) as independent axes;
    activity is derived from live membership, personal state is what the person declares
  - orthogonality proven: DND + IN_PRIVATE_LAYUP, and joining a layup never changes personal
    presence (`TestActivityIsOrthogonalToPersonalPresence`)
  - redaction is per viewer: an outsider on a private layup gets coarse busy state with no
    layup id, title or participant count; participants and the person themselves see detail;
    an organisation-open layup exposes title/participants
    (`TestPrivateLayupDetailIsRedactedForOutsiders`, `TestOpenLayupActivityIsDistinctFromPrivate`)
  - unknown users are OFFLINE; unknown states are rejected with ErrInvalid

## Recent runs

- P1-0101 done - domain IDs and core types
- P1-0102 done - layup lifecycle service
- P1-0103 done - creator privilege devolution invariant
- P1-0104 done - development user and organisation directory
- P1-0105 done - presence state model

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
