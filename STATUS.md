# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0305
- completed: 32
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0304 direct 1:1 WebRTC peer connection
- result: done
- tests: `npm test` (137 passed incl. 10 peer cases), `make test-webrtc` -> WEBRTC OK (real Chromium, real track)
- evidence:
  - `apps/desktop/src/core/peer-connection.ts` - perfect negotiation (polite/impolite derived
    from the two membership ids, so both sides agree with no extra round trip), trickle ICE,
    automatic renegotiation, explicit `signal.bye` teardown, and a state object that explains a
    failure instead of hanging
  - 10 unit tests drive the logic against a fake RTCPeerConnection: offer/answer, candidate
    relay, glare resolution both ways, forced-relay configuration, single goodbye, teardown on
    a remote goodbye
  - real proof (`make test-webrtc`): two connections built by the *production* module negotiate
    inside a real Electron/Chromium window and a real canvas-captured video track flows across:
    `{connected: true, gotTrack: true, receivedTrackKind: "video", route: "succeeded:host",
    bytesSent: 1756, offers: 1, answers: 1, candidates: 2}`
  - wired into CI (`xvfb-run npm run test:webrtc`) beside the boundary proof

## Recent runs

- P1-0210 done - menu/tray pending attention
- P1-0301 done - enumerate and preview capture sources
- P1-0302 done - capture permission onboarding
- P1-0303 done - WebRTC signalling protocol
- P1-0304 done - direct 1:1 WebRTC peer connection

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
