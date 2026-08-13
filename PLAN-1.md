# PLAN-1 - Prove the magic

**Status: EXECUTABLE**

This is the only implementation plan Ralph is authorised to execute.

`TASKS.yaml` is the atomised form of this plan. If prose here and a task conflict, stop and resolve the inconsistency rather than guessing.

## Objective

Prove that Layup is meaningfully better than ordinary meeting software for real-time pairing.

The plan ends at one hard human/product gate:

> Two people open Layup, see each other, one clicks the other, the recipient accepts, audio/video connects, one shares a screen, both have independent cursors, both can draw, and permitted remote mouse/keyboard control feels good enough that they would voluntarily pair for an hour.

PLAN-2 remains locked until this has been demonstrated on real machines and `PLAN-1-REVIEW.md` is completed.

## Deliberate constraints

PLAN-1 does **not** optimise for production scale. It optimises for truth.

Do not add:

- SFU/multiparty architecture;
- Redis or a message broker;
- OIDC/SAML;
- production database migrations;
- recording;
- file transfer;
- multi-screen sharing;
- custom TURN;
- custom congestion control;
- Chromium fork;
- native capture/encoding merely because it seems faster in theory.

## Phase A - Foundation and measurement

Create the Electron/React/TypeScript desktop, Go control service, protocol boundary, hardened IPC and CI. Establish a benchmark harness before media work.

Evidence required:

- macOS/Windows/Linux desktop build jobs;
- desktop can reach Go `/healthz`;
- protocol version visible on both sides;
- structured logs;
- repeatable latency/benchmark harness skeleton.

## Phase B - People, presence and layup domain

Implement identity fixtures, people/presence, layup/membership lifecycle and the creator-devolution invariant before media complicates the state model.

Hard invariant:

```text
creator membership leaves
  -> creator authority disappears permanently
  -> nobody inherits it
  -> same user rejoins as ordinary participant
```

Evidence required:

- two clients see each other's presence;
- create/join/leave logical layup;
- layup continues while at least one membership remains;
- creator devolution is covered by automated tests.

## Phase C - Social loop

Make the home screen useful before adding screen sharing:

- invite an available person to a new layup;
- invite a person into an existing layup;
- knock on a private layup;
- collapse duplicate knocks;
- expire/cancel/decline requests;
- organisation-open discoverable layups;
- link joins;
- OS-level menu/tray attention;
- if already in a layup: Join theirs / Invite them here / Decline.

No literal room graph merging.

Evidence required:

- core `People -> click -> accept -> same logical layup` path needs no room code;
- private outsider sees coarse busy state only;
- open layup exposes permitted title/participants/join affordance.

## Phase D - Real 1:1 session

Add desktop capture, P2P WebRTC, TURN fallback and minimal audio/video.

Media begins only after the social request is accepted.

Join defaults:

```text
resulting participant count 1-4:
  camera ON
  microphone ON

participant 5+:
  camera ON
  microphone MUTED
```

PLAN-1 remains primarily 1:1, but the mute threshold belongs in the domain/session policy now so it is not bolted on later.

Evidence required on real machines:

1. LAN connection;
2. ordinary NAT connection;
3. forced TURN connection;
4. screen is readable and interactive enough to continue;
5. baseline glass-to-glass and network metrics recorded.

## Phase E - Independent cursors and drawing

Add synthetic cursors as overlays, independent of the screen video and host OS pointer. Add vector drawing over a separate data path.

Presenter may disable drawing immediately.

Evidence required:

- at least four synthetic participant cursors can be driven in a stress test;
- cursor queues do not grow unbounded;
- cursor presentation remains responsive when video FPS drops;
- drawing on/off is enforced, not just hidden in UI.

## Phase F - Remote control

Introduce the privileged native helper and reliable input channel.

Support first on macOS and Windows:

- click/double-click/right-click;
- wheel;
- drag;
- keyboard and modifiers;
- short pointer/keyboard leases;
- local presenter input priority;
- individual revoke;
- immediate all-user emergency revoke;
- stuck key/button cleanup.

Presenter control is sovereign over their machine. No room moderator is required.

Evidence required:

- guest can operate a normal editor;
- presenter can revoke instantly;
- disconnect cannot leave a stuck key/button;
- renderer never receives arbitrary OS injection capability.

## Phase G - Integrate and dogfood

Do not call PLAN-1 complete because components exist independently.

Exercise the actual product journey repeatedly:

```text
launch
-> see person
-> click
-> accept
-> AV connects
-> share screen
-> cursors
-> draw
-> remote control
-> presenter stops sharing
-> layup continues with AV
-> another participant shares
-> creator leaves
-> layup continues without authority transfer
```

Run a one-hour pairing soak on real machines and collect:

- perceived interaction problems;
- p50/p95 screen latency if measurable;
- input RTT;
- CPU/memory;
- TURN versus direct behaviour;
- crashes/reconnects;
- permission friction;
- anything that made users reach for another tool.

## PLAN-1 completion rule

When every task is complete, Ralph must write `PLAN-1 GATE READY` to `STATUS.md` and stop.

Ralph must **not**:

- unlock PLAN-2;
- invent PLAN-2 tasks;
- declare the product experience good enough on behalf of humans.

Humans complete `PLAN-1-REVIEW.md`. Only then is PLAN-2 rewritten and atomised.
