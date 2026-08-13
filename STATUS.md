# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0205
- completed: 22
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0204 knock on private layup
- result: done
- tests: `make test-go` (4 knock cases), `npm test` (100 passed), typecheck/lint/fmt green, boundary OK
- evidence:
  - a knock is addressed at a *person*, not a layup id: the server resolves which layup they
    are in, so the requester never learns it. The knock then belongs to the layup, so any
    participant may admit it (`TestKnockingIsAddressedAtAPersonAndRevealsNothing`)
  - the knocker's own pending request carries no `layupId` and no title; participants inside do
    see which layup is being knocked on
  - one acceptance admits exactly once: a second acceptance is 409 and the knocker holds
    exactly one membership (`TestOneAcceptanceAdmitsTheKnockerExactlyOnce`)
  - knocking on someone who is idle, or on a layup you are already in, is 409
  - declining leaves the knocker outside; participants are notified over realtime
  - desktop: the People tile's Knock action calls `requests.knock(userId)` and the Join action
    joins an open layup directly

## Recent runs

- P1-0110 done - creator devolution end-to-end test
- P1-0201 done - join request domain and lifecycle
- P1-0202 done - invite available person to new layup
- P1-0203 done - invite person into existing layup
- P1-0204 done - knock on private layup

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
