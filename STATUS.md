# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0304
- completed: 31
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0303 WebRTC signalling protocol
- result: done
- tests: `make test-go` (4 signalling cases over real WebSockets), fmt/vet green
- evidence:
  - signalling rides the existing realtime envelope: `signal.offer`, `signal.answer`,
    `signal.candidate`, `signal.bye`, addressed by *membership* so a rejoin never inherits a
    half-finished negotiation
  - the server relays and nothing else: it never inspects, rewrites, stores or logs SDP or
    candidates (the debug line carries route metadata only) and is never in the media path
  - the sender is stamped server-side: a forged `fromMembershipId`/`fromUserId` is overwritten
    (`TestSenderCannotSpoofIdentityOrReachOutsideTheLayup`)
  - both ends must be active participants of the named layup - an outsider gets
    "you are not in that layup", an unknown membership is rejected, and a peer cannot signal
    itself
  - malformed messages (no layup, no recipient, offer without sdp) get an error envelope and
    the connection survives

## Recent runs

- P1-0209 done - invite while already in a layup
- P1-0210 done - menu/tray pending attention
- P1-0301 done - enumerate and preview capture sources
- P1-0302 done - capture permission onboarding
- P1-0303 done - WebRTC signalling protocol

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
