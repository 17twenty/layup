# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0204
- completed: 21
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0203 invite person into existing layup
- result: done
- tests: `make test-go` (4 new cases), `npm test` (100 passed), lint/fmt green
- evidence:
  - `INVITE_USER_TO_LAYUP`: accepting joins the existing layup rather than creating another,
    and creator authority is untouched by the new arrival
    (`TestInvitingIntoAnExistingLayupJoinsThatLayup`)
  - only an active participant may invite into a layup (403 otherwise); inviting someone
    already inside is a 409, as is inviting into an ended layup
  - the recipient gets the layup context they are entitled to - `layupId` and title are
    included for the invited person even for a private layup, because they are being asked in
  - declining changes nothing: memberships, creator authority and layup state are identical
    afterwards, and the invitee still cannot join a private layup on their own
    (`TestDecliningAnInvitationChangesNoMemberships`)
  - desktop: clicking a person while already in a layup invites them *here*
    (`requests.invite(userId, {layupId})`), not into a second layup

## Recent runs

- P1-0109 done - logical layup create/join/leave API
- P1-0110 done - creator devolution end-to-end test
- P1-0201 done - join request domain and lifecycle
- P1-0202 done - invite available person to new layup
- P1-0203 done - invite person into existing layup

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
