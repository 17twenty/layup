# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0301
- completed: 28
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0210 menu/tray pending attention
- result: done
- tests: `npm test` (110 passed incl. 5 attention cases), typecheck/lint green, boundary OK
- evidence:
  - `apps/desktop/src/main/attention.ts` - badge, tooltip and a single dock bounce / frame
    flash while a request is pending; wired to the requests supervisor so it always reflects
    current state rather than a stream of events
  - no repeated OS notification for repeated clicks: alerting is keyed on request id, and
    repeated clicks collapse upstream into one request
    (`does not alert again while the same request stays pending`)
  - the badge and tooltip clear on accept, decline or expiry; a genuinely new request (new id)
    alerts again, including after an earlier one was resolved
  - outgoing requests never raise OS attention - your own waiting is not an interruption
  - 5 unit tests drive an injected surface, so the rules are proven without Electron

## Recent runs

- P1-0206 done - organisation-open layups and Happening Now
- P1-0207 done - link-join layups
- P1-0208 done - incoming invitation experience
- P1-0209 done - invite while already in a layup
- P1-0210 done - menu/tray pending attention

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
