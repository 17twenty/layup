# Layup Architecture

## 1. Architectural goal

Optimise for a Screenhero-like feeling: the remote machine should feel shared, not like a video conference with screen sharing bolted on.

The architecture separates three concerns:

```text
social/control state       interactive media/data       local privileged action
        |                          |                             |
        v                          v                             v
   Go control plane          WebRTC peer path             native helper
```

The backend must never become the accidental hot path for cursor motion or 1:1 video.

## 2. Process model

```text
+---------------------------------------------------------------+
| Electron desktop                                              |
|                                                               |
|  +-------------------+        +----------------------------+  |
|  | React renderer    | <----> | hardened preload bridge    |  |
|  | unprivileged      |        +-------------+--------------+  |
|  +-------------------+                      |                 |
|                                             v                 |
|                                  +-------------------------+  |
|                                  | Electron main process   |  |
|                                  | capture/WebRTC/session  |  |
|                                  +------------+------------+  |
+-----------------------------------------------|---------------+
                                                |
                                  authenticated local IPC
                                                |
                                                v
                                  +-------------------------+
                                  | native input helper     |
                                  | OS input injection only |
                                  +-------------------------+
```

The renderer never receives arbitrary Node or OS-injection capability.

## 3. Network model

### 3.1 Control plane

The Go service owns durable or authoritative human/social state:

- identity and organisation boundary;
- user directory;
- personal/activity presence;
- layup metadata and memberships;
- invitation/knock lifecycle;
- WebRTC signalling;
- policy;
- audit events;
- TURN credential issuance;
- operational telemetry.

Transport during PLAN-1:

```text
HTTPS - commands/queries
WSS   - presence, invitations, layup membership and signalling events
```

### 3.2 Data plane

WebRTC carries latency-sensitive session traffic:

- shared desktop video;
- camera video;
- audio;
- synthetic cursor updates;
- drawing events;
- remote-input events.

For 1:1 calls the normal route is:

```text
Desktop A <---------------- direct WebRTC ----------------> Desktop B
     \                                                        /
      +------------------- TURN fallback --------------------+
```

The Go control plane is not in the 1:1 media path.

### 3.3 Future multiparty

PLAN-2 may introduce an SFU, with LiveKit as the current reference candidate. That is a hypothesis, not an authorised PLAN-1 dependency.

Business/domain semantics must not depend on whether media is P2P or SFU-routed.

## 4. Domain authority model

There is deliberately no transferable host/moderator role.

### Creator authority

Creator privilege is attached to the **original membership**, not to a user identity.

```text
Nick creates layup
  -> membership A is creator membership
Nick leaves
  -> membership A ends
  -> creator privileges cease forever
Nick rejoins
  -> membership B is ordinary
```

No host election, no reassignment, no privilege resurrection.

### Presenter authority

A presenter is sovereign over access to their own machine while their screen is active. They may stop sharing, disable drawing/control, revoke grants and invoke emergency revoke.

### Participant authority

A participant controls their own camera/microphone/presence and requests they originate.

## 5. Screen-share model

Exactly one active shared desktop exists per layup.

A layup with no shared screen remains a valid audio/video room.

For collaborative/private layups, a participant may take over sharing with a brief transition notice rather than approval theatre. For advertised/open presentation-style layups, non-presenters request to share.

No simultaneous multi-screen sharing in PLAN-1 or PLAN-2 unless SPEC is explicitly changed.

## 6. Cursor and input model

Synthetic cursors and OS input are separate concepts.

### Cursor motion

- rendered as local overlays;
- normalised coordinates;
- unordered/loss-tolerant/latest-wins;
- coalesced and interpolated;
- never moves the host's physical OS cursor by itself.

### Destructive input

Clicks, drags and keys travel on a reliable channel and are arbitrated before native injection.

Pointer drag uses a short exclusive lease. Keyboard input uses a short focus/typing lease. Presenter physical input has priority.

## 7. WebRTC channels

Recommended semantic channels:

```text
cursor-fast
  unordered, lossy/latest-wins

annotation-fast
  loss-tolerant where practical

input-reliable
  ordered, reliable
```

Do not mix cursor position updates into reliable input queues: stale cursor motion is worse than packet loss.

## 8. Capture/encoding strategy

PLAN-1 begins with Electron/Chromium desktop capture and WebRTC. Do not fork Chromium or add a custom native encoder until measurements prove it is required.

Latency is measured from the first phase. Benchmark evidence, not aesthetic preference, decides whether PLAN-2 needs a native capture/encode spike.

## 9. TURN

Use coturn. TURN fallback is a supported path, not an exceptional failure mode.

PLAN-1 must test:

1. same-LAN direct path;
2. ordinary Internet/NAT path;
3. forced relay path.

Do not implement a TURN server.

## 10. Persistence in PLAN-1

PLAN-1 may begin with deterministic in-memory repositories for product/domain work. Persistence is not allowed to distort the domain API.

Production persistence, migrations and clustering belong to PLAN-2 unless a PLAN-1 gate exposes a genuine need earlier.

## 11. Security boundaries

Hard boundaries:

- context isolation enabled;
- Node integration disabled in renderer;
- typed/narrow preload surface;
- all IPC inputs validated;
- native helper authenticated locally;
- remote-control state visibly indicated;
- emergency revoke always locally available;
- raw keystrokes, screen pixels, audio/video and cursor trails are never persisted as audit data.

## 12. Observability

Instrument from day one:

- connection state;
- ICE route/candidate type;
- RTT;
- encode/decode timing where exposed;
- frame rate/resolution/bitrate;
- dropped frames;
- cursor event rate/coalescing;
- input round-trip timing;
- memory/CPU during soak tests.

Performance regressions are task failures when a task defines a budget.

## 13. Current decisions versus hypotheses

Locked for PLAN-1:

- Electron desktop;
- Go control plane;
- WebRTC P2P first;
- coturn;
- native input helper;
- one active shared desktop;
- no moderator role;
- membership-scoped creator privilege;
- presenter sovereignty;
- synthetic cursors separated from OS input.

Provisional for PLAN-2:

- LiveKit for multiparty;
- Postgres as primary persistence;
- exact adaptive-quality controller;
- native capture/encoding work;
- OIDC/provider UX;
- packaging/update mechanism.
