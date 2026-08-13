# Layup

Layup is an open-source, enterprise-self-hostable collaboration application inspired by the immediacy of Screenhero/Pop and the social presence of MSN Messenger.

The product model is deliberately simple:

> **People -> Layup -> Share -> Collaborate**

This repository is initially driven by a Ralph-style looped implementation agent. The repository itself contains the contract the agent must follow.

## Start here

Read in this order:

1. `SPEC.md` - product truth and invariants.
2. `ARCHITECTURE.md` - technical boundaries and trust model.
3. `PLAN-1.md` - executable first tranche. This is what Ralph may build now.
4. `RALPH.md` - one-task-per-run operating contract.
5. `TASKS.yaml` - atomised PLAN-1 backlog.
6. `STATUS.md` - current execution state and the evidence for it.
7. `docs/adr/` - the architecture decisions accepted for PLAN-1.

`PLAN-1-REVIEW.md` is the human review template used when PLAN-1 is complete.
PLAN-2 does not exist yet and is not written until after that review.

## The PLAN-1 product gate

PLAN-1 earns completion only when this is true on real machines:

> Two people open Layup, see each other, one clicks the other, the recipient accepts, audio/video connects, one shares a screen, both have independent cursors, both can draw, and permitted remote mouse/keyboard control feels good enough that they would voluntarily pair for an hour.

If that experience is not delightful, PLAN-2 remains locked.

## Ralph

A loop invocation should use something equivalent to:

```text
You are Ralph. Follow RALPH.md exactly. Complete exactly one eligible task from TASKS.yaml, update TASKS.yaml and STATUS.md, commit if possible, then exit.
```

To see the next eligible task:

```bash
python3 scripts/next_task.py
```

To validate the task graph:

```bash
python3 scripts/validate_tasks.py
```

## Toolchains

Pinned in `.tool-versions` / `mise.toml`:

```text
node 26.5.0   (npm 11.x workspaces; package manager pinned via packageManager)
go   1.26.4   (go.work spans protocol/go, services/control)
```

Install and run:

```bash
make bootstrap     # npm ci / npm install
make dev-control   # Go control service
make dev           # Electron desktop (Vite renderer + compiled main/preload)
make check         # typecheck + lint + test + build for every component
```

`make help` lists every developer command.

Evidence harnesses (each builds what it tests, so they fail on drift):

```bash
make verify         # check + every proof below
make test-smoke     # desktop clients against a real Go control service
make test-e2e       # domain invariants over the real wire, no app code imported
make test-boundary  # renderer privilege proof in a real Electron window
make test-webrtc    # two real peer connections carrying a real video track
make bench          # latency scenarios -> benchmarks/results/**.json
```

See `benchmarks/README.md` for the result schema and `test/e2e/README.md` for what
each harness proves.

## Repository shape

```text
.
├── SPEC.md ARCHITECTURE.md PLAN-1.md RALPH.md TASKS.yaml STATUS.md   contract
├── PLAN-1-REVIEW.md REFERENCES.md                                    review inputs
├── docs/adr/                 accepted architecture decisions
├── protocol/                 the wire contract
│   ├── VERSION               single source of truth for the version
│   ├── go/                   Go binding   (envelope, realtime types)
│   └── ts/                   TS binding   (@layup/protocol, validators)
├── services/control/         Go control plane
│   ├── cmd/control/          entry point
│   └── internal/
│       ├── domain/           layups, memberships, presence, requests
│       ├── httpapi/          HTTP + WSS surface, signalling relay, TURN
│       ├── realtime/         connection hub and fan-out
│       ├── presencefeed/     per-viewer presence publication
│       ├── directory/        development identities
│       ├── config/ logging/ buildinfo/
├── apps/desktop/             Electron desktop
│   ├── src/main/             privileged: windows, capture, IPC, supervisors
│   ├── src/preload/          the entire renderer-facing surface
│   ├── src/renderer/         React UI (People, invitations, layup, capture)
│   ├── src/core/             framework-free logic (control client, realtime,
│   │                         peer connection, ICE diagnostics, stores)
│   ├── src/shared/           the IPC contract
│   └── test/                 boundary and WebRTC harnesses
├── native/input-helper/      privileged input helper (Phase F)
├── deploy/compose/           control service + coturn
├── test/                     e2e (wire contract), latency harness, network
├── benchmarks/               harness docs + committed result JSON
└── scripts/                  task-graph tooling
```

The Go workspace (`go.work`) spans `protocol/go` and `services/control`.
The npm workspace spans `protocol/ts` and `apps/desktop`.
