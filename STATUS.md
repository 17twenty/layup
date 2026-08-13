# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0210
- completed: 27
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0209 invite while already in a layup
- result: done
- tests: `make test-go` (3 busy-invite cases), `npm test` (105 passed incl. 3 new UI cases)
- evidence:
  - "Join theirs" leaves the current layup *first*, then joins the target, in that order, so
    the two layups never briefly overlap; the abandoned layup continues for the people left in
    it (`TestJoinTheirsLeavesTheCurrentLayupFirst`)
  - no graph merge anywhere: the two layups remain two layups with their own participants, and
    creator authority is unaffected
  - "Invite them here" sends `INVITE_USER_TO_LAYUP` for the layup you are in and declines
    theirs; accepting lands the other person in your existing layup, and exactly one layup
    exists afterwards (`TestInviteThemHereCreatesAnInvitationToTheCurrentLayup`)
  - declining while busy changes nothing at all
  - the UI shows the three-way choice only when it applies: a knock never offers to move you,
    and with no current layup it stays a plain Join / Not now

## Recent runs

- P1-0205 done - collapse, cancel and expire requests
- P1-0206 done - organisation-open layups and Happening Now
- P1-0207 done - link-join layups
- P1-0208 done - incoming invitation experience
- P1-0209 done - invite while already in a layup

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
