# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0107
- completed: 14
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0106 realtime WebSocket envelope
- result: done
- tests: `make test-go` (incl. 7 realtime cases), `npm test` (61 passed), `make test-smoke` (6 passed), boundary OK
- evidence:
  - Go: `internal/realtime` (hub + connection) and `GET /api/realtime` (coder/websocket).
    Handshake travels on the query string (`?v=1&devUser=karl`) because the desktop runtime's
    WebSocket cannot set headers; headers still work when present
  - server sends `hello.ok` (connectionId, userId, organisationId, protocol version, heartbeat
    interval), then heartbeats; clients ack. Malformed frames get an error envelope and the
    connection survives (`TestRealtimeRejectsMalformedMessagesWithoutClosing`)
  - fan-out is organisation-scoped, and a connection whose queue is full is dropped rather than
    buffered without limit (`TestHubDropsAConnectionThatCannotKeepUp`)
  - desktop `src/core/realtime-client.ts`: backoff+jitter reconnect, heartbeat watchdog
    (interval x3), subscriptions held on the client so a reconnect never duplicates handlers,
    malformed events rejected (10 unit tests)
  - main process owns the socket and pushes validated `realtime:state` events to windows;
    preload validates every push before the UI sees it
  - real smoke evidence (`make test-smoke`, 6 passed): two clients connect independently;
    killing the server puts the client into `reconnecting` and it reconnects by itself with
    exactly one `hello.ok` handler invocation per connection
  - fixed: the logging middleware hid `http.Hijacker`, which turned every upgrade into a 501
    (`TestMiddlewareKeepsWebSocketUpgradesPossible`)

## Recent runs

- P1-0102 done - layup lifecycle service
- P1-0103 done - creator privilege devolution invariant
- P1-0104 done - development user and organisation directory
- P1-0105 done - presence state model
- P1-0106 done - realtime WebSocket envelope

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
