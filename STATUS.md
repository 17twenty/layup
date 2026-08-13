# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0109
- completed: 16
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0108 people home grid
- result: done
- tests: `npm test` (82 passed incl. 13 new people cases), typecheck/lint/build green, boundary OK
- evidence:
  - `apps/desktop/src/renderer/people/` - `PeopleGrid` is the home surface: one tile per
    colleague with avatar initials, name, presence dot, presence/activity label, status
    message and open-layup participant count. Self is excluded from the grid
  - `primary-action.ts` encodes SPEC §5.1 as a pure function: AVAILABLE -> Start layup
    (primary), AWAY -> Start layup (secondary), DND -> disabled unless policy allows,
    IN_PRIVATE_LAYUP -> Knock, IN_OPEN_LAYUP -> Join, INVITING_YOU -> Join,
    WAITING_FOR_YOU -> Waiting, OFFLINE -> disabled. 8 unit tests
  - states are visually distinguishable: per-tile classes (`tile--dnd`, `tile--offline`,
    `tile--activity-in_open_layup`), coloured presence dots, disabled/secondary buttons
  - no meeting wizard: the App renders People first with connection/identity chrome in a
    footer; tests assert no "New Meeting" affordance exists
  - the grid is fed by realtime pushes (`people:changed`), asserted live in
    `PeopleGrid.test.tsx` ("updates live when presence is pushed")

## Recent runs

- P1-0104 done - development user and organisation directory
- P1-0105 done - presence state model
- P1-0106 done - realtime WebSocket envelope
- P1-0107 done - presence publication and fan-out
- P1-0108 done - people home grid

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
