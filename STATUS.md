# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0108
- completed: 15
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0107 presence publication and fan-out
- result: done
- tests: `make test-go` (5 presence wire cases), `npm test` (67 passed), `make test-smoke` (9 passed), boundary OK
- evidence:
  - `services/control/internal/presencefeed` - `presence.snapshot` on connect, then
    `presence.update` deltas. Every recipient gets its own rendering
    (`Hub.BroadcastPerRecipient`), because redaction is viewer-dependent
  - connect -> AVAILABLE, last client closing -> OFFLINE (a second window keeps you online);
    `presence.set` lets a client declare AWAY/DND and it is published to others
  - wire-level redaction proof: an outsider's snapshot of someone in a private layup titled
    "Acquisition of Initech" contains no title, no layup id and no participant count
    (`TestPresencePayloadsDoNotLeakPrivateLayupDetail`)
  - desktop `src/core/people-store.ts` - snapshot replaces, update patches, malformed payloads
    rejected; main process pushes validated `people:changed` events, `people:list` for the
    initial read
  - real two-client evidence (`make test-smoke`, 9 passed): Nick sees the whole organisation on
    connect, sees Karl go AVAILABLE then OFFLINE with no polling, and never receives private
    layup detail

## Recent runs

- P1-0103 done - creator privilege devolution invariant
- P1-0104 done - development user and organisation directory
- P1-0105 done - presence state model
- P1-0106 done - realtime WebSocket envelope
- P1-0107 done - presence publication and fan-out

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
