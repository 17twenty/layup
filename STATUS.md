# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0307
- completed: 34
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0306 coturn configuration and ephemeral credentials
- result: done
- tests: `make test-go` (4 TURN cases incl. config validation), fmt/vet green
- evidence:
  - `GET /api/turn` issues coturn REST credentials: username `<expiry>:<userId>`, password
    HMAC-SHA1 of it under a secret shared with coturn's `use-auth-secret`. The secret never
    leaves the server and is never logged (`TestTurnCredentialsAreShortLivedAndDerived`)
  - credentials last 12h and are deterministic for a given expiry, so a client can be handed a
    fresh pair on demand
  - configuration is validated, not defaulted: TURN URLs without a secret, a non-turn: scheme,
    or FORCE_RELAY with no TURN server all fail startup with a named complaint
  - with no TURN configured the endpoint still returns a working STUN-only configuration
  - `deploy/compose/docker-compose.yml` + `control.Dockerfile`: the minimum self-hostable
    deployment (control service + coturn, `use-auth-secret` matching the issued credentials,
    relay port range, distroless non-root image). Layup does not implement TURN

## Recent runs

- P1-0302 done - capture permission onboarding
- P1-0303 done - WebRTC signalling protocol
- P1-0304 done - direct 1:1 WebRTC peer connection
- P1-0305 done - trickle ICE and route diagnostics
- P1-0306 done - coturn configuration and ephemeral credentials

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
