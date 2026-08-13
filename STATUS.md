# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0206
- completed: 23
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0205 collapse, cancel and expire requests
- result: done
- tests: `make test-go` (4 expiry/collapse cases incl. background sweeper), fmt/vet green
- evidence:
  - collapse: repeated invitations and repeated knocks reuse the one pending request, so the
    recipient sees a single entry and receives a single `request.incoming` push
    (`TestRepeatedKnocksDoNotRepeatNotifications`)
  - cancel: only the sender may cancel; the recipient is told over realtime and the request can
    never be accepted afterwards (`TestSenderCanCancelAndBothSidesAreTold`)
  - expiry: `SweepExpiredRequests` publishes `request.resolved` with state EXPIRED to both
    sides, the request disappears from both lists, and accepting it is 409
    (`TestExpiredRequestsDisappearAndAreAnnounced`)
  - `StartExpirySweeper` runs the sweep in the background (wired into `cmd/control`); expiry
    itself stays deterministic - the sweep only decides how promptly people are told
  - the desktop drops expired requests locally too, so a stalled connection cannot leave a
    stale invitation on screen

## Recent runs

- P1-0201 done - join request domain and lifecycle
- P1-0202 done - invite available person to new layup
- P1-0203 done - invite person into existing layup
- P1-0204 done - knock on private layup
- P1-0205 done - collapse, cancel and expire requests

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
