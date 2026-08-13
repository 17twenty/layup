# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0203
- completed: 20
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0202 invite available person to new layup
- result: done
- tests: `make test-go` (6 request cases), `npm test` (100 passed), `make test-e2e` (4 scenarios), boundary OK
- evidence:
  - `POST /api/requests` + `/accept|/decline|/cancel` + `GET /api/requests`; only the recipient
    may accept/decline and only the sender may cancel (403 otherwise), and a resolved request
    cannot be re-resolved (409)
  - accepting `INVITE_USER_TO_NEW_LAYUP` calls `CreateLayupWithGuests`, so one layup and both
    memberships appear together; a failure discards the layup rather than leaving it half-formed
  - the inviter's membership is the creator membership; the accepter joins as ordinary
  - viewer-relative presence is live: the recipient's tile for the sender reads INVITING_YOU and
    the sender's tile for the recipient reads WAITING_FOR_YOU
    (`TestInvitationChangesViewerRelativeActivity`)
  - repeated clicks collapse: one `request.incoming` push, one entry in the recipient's list
  - desktop: `main/requests.ts` supervisor + `requests:*` IPC + `Invitations` UI (6 tests);
    the People tile's "Start layup" sends an invitation and starts no media
  - e2e (`make test-e2e`, 4 scenarios): click -> invitation -> accept -> one layup with both
    people, creator authority held by the inviter, both sides told over realtime; and repeated
    clicks produce exactly one notification with declining being final

## Recent runs

- P1-0108 done - people home grid
- P1-0109 done - logical layup create/join/leave API
- P1-0110 done - creator devolution end-to-end test
- P1-0201 done - join request domain and lifecycle
- P1-0202 done - invite available person to new layup

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
