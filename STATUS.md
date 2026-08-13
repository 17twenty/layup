# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0209
- completed: 26
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0208 incoming invitation experience
- result: done
- tests: `npm test` (102 passed incl. 8 invitation cases), typecheck/lint green
- evidence:
  - `Invitations` is a page section, not a modal: it sits above People so you can see who is
    asking without losing the app (asserted: a `region` labelled Invitations, no `dialog`)
  - accept/decline update immediately - the card is removed on click, before the round trip
    completes, and is restored with the reason if the command fails
    (`accepting removes the card immediately`, `restores the card and explains when a command fails`)
  - context is privacy-filtered by type: a knock says "They want to join the layup you are in"
    and never names it; an invitation shows a title only when the server sent one
  - a live countdown shows how long is left and the card disappears when the request runs out,
    so an expired invitation is never clickable
  - 8 renderer tests cover all of the above

## Recent runs

- P1-0204 done - knock on private layup
- P1-0205 done - collapse, cancel and expire requests
- P1-0206 done - organisation-open layups and Happening Now
- P1-0207 done - link-join layups
- P1-0208 done - incoming invitation experience

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
