# Layup - Functional & Technical Specification

## 0. Product thesis

Layup is an open-source, enterprise-self-hostable collaboration app inspired by the immediacy of Screenhero/Pop and the social presence of MSN Messenger.

The product is not meeting-first. It is people-first:

> **People -> Layup -> Share -> Collaborate**

A layup is an ephemeral shared space that can contain audio, video, a single active shared screen, independent synthetic cursors, drawing, and optionally remote mouse/keyboard control.

The primary product moment is:

1. I launch Layup and see my colleagues.
2. I click Karl.
3. Karl gets an invitation/knock and accepts.
4. Within roughly two seconds we are in a layup with camera/audio active according to policy.
5. I share my screen.
6. We both have independent visible cursors.
7. If enabled, Karl can draw or control my machine.

The implementation target is:

- Desktop: Electron + React + TypeScript, macOS/Windows/Linux.
- Control plane: Go, self-hostable.
- Media: WebRTC, P2P first for 1:1, TURN fallback.
- Multiparty: SFU later; LiveKit is the initial reference candidate.
- TURN/STUN: coturn.
- Remote input: native helper per platform, never exposed directly to the renderer.

## 1. Non-goals

Layup is **not** a Slack/Teams replacement.

Do not add, unless explicitly scheduled in a later stage:

- persistent chat channels;
- threads;
- documents;
- calendars;
- task management;
- multi-screen simultaneous presentation;
- custom TURN implementation;
- custom SFU implementation;
- custom WebRTC congestion controller;
- Chromium fork;
- recording;
- file transfer;
- mobile client.

## 2. Product principles

### 2.1 People are the home screen

The primary surface is a grid/list of people and live activity, not a "New Meeting" wizard.

### 2.2 A layup does not need an owner

The creator has temporary creator privileges tied to their **original membership**, not their user identity.

If the creator leaves:

- the layup continues while any participant remains;
- creator privileges disappear permanently;
- no moderator is elected;
- if the former creator rejoins, they are an ordinary participant;
- existing layup settings remain frozen unless a permitted participant-owned action changes them.

There is no transferable moderator role.

### 2.3 You control yourself and your machine

Authority is deliberately local:

- participants control their own mic/camera/presence;
- a presenter controls access to their shared machine;
- a participant controls invitations/knocks they originate;
- organisation policy defines upper bounds.

### 2.4 Presenter sovereignty

The active presenter can always:

- stop sharing;
- disable drawing on their screen;
- disable remote pointer control;
- disable remote keyboard control;
- revoke an individual participant's remote-control grant;
- emergency-revoke all remote control.

These are safety rights, not moderation rights.

### 2.5 Latency is a product feature

Measure from Stage 0.

Critical video path:

```text
capture -> encode -> network -> decode -> render
```

Critical control path:

```text
remote input -> network -> validate/arbitrate -> OS injection -> app reacts -> next frame
```

Do not add buffering that improves visual perfection at the expense of stale interaction.

### 2.6 Social conventions over permission theatre

Normal trusted layups should feel casual.

For ordinary private layups, any participant may take over the single shared screen without an approval dialog. The existing presenter receives a brief transition notice.

For advertised/open presentation-style layups, non-privileged participants request to share rather than forcibly replacing the presenter.

## 3. Core domain model

### 3.1 User

Stable identity.

```text
User
- id
- organisation_id
- display_name
- avatar
- status_message
```

### 3.2 Presence

Personal presence and activity presence are orthogonal.

Personal:

```text
AVAILABLE
AWAY
DND
OFFLINE
```

Activity:

```text
NONE
IN_PRIVATE_LAYUP
IN_OPEN_LAYUP
INVITING_YOU
WAITING_FOR_YOU
```

Presence is advisory. A busy user can still be invited unless DND policy forbids surfacing it.

### 3.3 Layup

```text
Layup
- id
- organisation_id
- title?
- visibility
- created_at
- ended_at?
- creator_membership_id
- drawing_default
- control_default
- active_screen_share_id?
```

Visibility:

```text
PRIVATE
ORGANISATION
LINK
```

Semantics:

- PRIVATE: only invited/accepted participants can enter.
- ORGANISATION: discoverable/joinable by organisation members.
- LINK: anyone possessing a valid invitation link may attempt to join subject to enterprise policy.

A layup is ACTIVE while at least one membership is active. When the final participant leaves, it ends.

### 3.4 Membership

Membership is incarnation-specific.

```text
Membership
- id
- layup_id
- user_id
- joined_at
- left_at?
- is_creator_membership
```

Important invariant:

> Creator privileges are tied to `Membership.id`, never `User.id`.

If the creator membership ends, creator privileges are gone forever for that layup.

### 3.5 Invitation / Knock

Use a unified request object with a direction/type.

```text
JoinRequest
- id
- layup_id?
- from_user_id
- to_user_id?
- request_type
- state
- created_at
- expires_at
```

Types:

```text
INVITE_USER_TO_LAYUP
INVITE_USER_TO_NEW_LAYUP
KNOCK_TO_JOIN
INVITE_LAYUP_TO_LAYUP   # later
```

States:

```text
PENDING
ACCEPTED
DECLINED
EXPIRED
CANCELLED
```

A pending knock is unique by `(requester, target_layup)`.

Repeated clicks do not create duplicate notifications.

### 3.6 ScreenShare

Only one active shared desktop per layup.

```text
ScreenShare
- id
- layup_id
- presenter_membership_id
- source_id
- started_at
- ended_at?
- allow_drawing
- allow_pointer
- allow_keyboard
```

### 3.7 CapabilityGrant

Internally model capabilities rather than only room booleans.

```text
VIEW_SCREEN
SHARE_SCREEN
DRAW
CONTROL_POINTER
CONTROL_KEYBOARD
SHARE_AUDIO
SHARE_CAMERA
```

The user-facing UI may collapse this to:

```text
Drawing                 [ON/OFF]
Mouse + keyboard        [ON/OFF]
```

but grants must remain per-participant capable.

## 4. Audio/video defaults

Unless overridden by stronger organisation policy or a user's explicit stricter local preference:

- joining a layup that results in 1-4 participants: camera ON, microphone ON;
- joining as participant 5 or later: camera ON, microphone MUTED.

Media starts only after the invitation/knock is accepted and membership creation succeeds.

A knock must never activate camera/microphone merely because the requester clicked another person's tile.

## 5. Home / People surface

The home screen contains three conceptual areas.

### 5.1 People

Each person tile shows:

- avatar/live preview where appropriate;
- name;
- personal presence;
- activity presence;
- status message where space allows;
- relevant primary action.

Primary action rules:

```text
AVAILABLE               -> Start layup
AWAY                    -> Start layup (lower emphasis)
DND                     -> Disabled or low-emphasis according to policy
IN_PRIVATE_LAYUP        -> Knock
IN_OPEN_LAYUP           -> Join
INVITING_YOU            -> Join / Decline
WAITING_FOR_YOU         -> Pending state / Cancel
```

### 5.2 Invitations

Pending incoming requests surface prominently and via OS-level attention cues.

Example:

```text
Karl wants you in a layup
Karl, Emelia
"Auth is doing something dumb"
[Join] [Not now]
```

### 5.3 Happening now

Organisation-visible open layups are discoverable.

Display:

- title;
- current participants;
- current presenter if any;
- participant count;
- join action.

Do not expose private layup title/participants to outsiders. Outsiders see only coarse busy presence.

## 6. Invitation and knock behaviour

### 6.1 Start with an available person

```text
A clicks B
-> server creates pending invitation/new-layup intent
-> B sees "A wants to start a layup"
-> B accepts
-> layup + memberships created atomically
-> media negotiation begins
```

### 6.2 Invite someone into an existing layup

```text
A in Layup X clicks B
-> B sees "A invited you to a layup"
-> B accepts
-> B joins X
```

### 6.3 Knock on a private layup

```text
A clicks B who is busy/private
-> A creates KNOCK_TO_JOIN against B's active layup
-> members of that layup see the knock according to policy
-> one acceptance admits A
```

### 6.4 Invite received while already in another layup

Initial UI:

```text
[Join theirs]
[Invite them here]
[Decline]
```

Do not implement literal graph/room merge in MVP.

`Invite them here` creates invitations to the current layup.

### 6.5 Expiry and attention

- requests expire after configurable timeout;
- sender may cancel;
- duplicate pending requests collapse;
- recipient may decline;
- before expiry, show non-spammy menu-bar/tray attention animation;
- optional "wave/nudge" is deferred until evidence it is needed.

## 7. Screen sharing

### 7.1 Single active presenter

Exactly one active `ScreenShare` per layup.

When no screen is shared, the layup remains valid audio/video social space.

### 7.2 Takeover

Private/collaborative layup:

```text
Participant B chooses Share my screen
-> brief notice to A
-> A's share stops
-> B's share starts
```

No approval prompt.

Open advertised layup:

```text
Participant chooses Ask to share
-> presenter/creator-membership holder may accept while present
```

If creator privileges have devolved and the current presenter is present, presenter decides.

If nobody is presenting, any participant can share.

### 7.3 Presenter collaboration controls

While sharing:

```text
Drawing                 [ON/OFF]
Mouse + keyboard        [ON/OFF]
```

Changing either setting applies immediately to the active screen share.

Turning control OFF must revoke all active pointer/keyboard grants immediately and release any held input lease.

## 8. Multi-cursor model

Operating systems normally expose one logical system pointer. Layup presents independent collaborative cursors as synthetic overlays.

### 8.1 Cursor movement

Cursor movement does **not** move the host OS pointer.

Transmit normalised coordinates:

```json
{
  "displayId": "display-1",
  "x": 0.52714,
  "y": 0.28391,
  "seq": 8492
}
```

Cursor channel properties:

- unordered;
- lossy/latest-wins;
- event coalescing;
- interpolation at receiver;
- independent of video frame rate.

### 8.2 OS actions

Remote destructive actions are separate from synthetic cursor movement.

Click:

```text
position OS pointer -> inject click -> release
```

Drag:

```text
acquire pointer lease -> mouse down -> moves -> mouse up -> release
```

Keyboard:

```text
acquire short keyboard/focus lease -> inject -> renew while typing -> release after inactivity
```

Host physical input always has precedence.

## 9. Drawing

Drawing is a WebRTC data-plane feature, not pixels baked into the shared video.

Protocol primitives:

```text
stroke.begin
stroke.points
stroke.end
stroke.clear
```

Drawing can be disabled:

- by default at share creation;
- at any time by the presenter;
- per participant later via capability grants.

When disabled, new strokes are rejected immediately. Existing annotations may be cleared according to UI action, not automatically unless specified.

## 10. Networking architecture

### 10.1 Control plane

Go service handles:

- authentication;
- organisation membership;
- presence;
- user directory;
- layup metadata;
- memberships;
- invitations/knocks;
- signalling;
- enterprise policy;
- ephemeral TURN credentials;
- audit events;
- observability.

### 10.2 Data/media plane

WebRTC carries:

- screen video;
- camera video;
- audio;
- cursor events;
- drawing events;
- remote-input events.

The Go service must not proxy 1:1 media in normal mode.

### 10.3 1:1 route preference

```text
1. direct UDP ICE
2. TURN over UDP
3. restrictive-network relay path supported by deployed TURN config
4. useful diagnostic failure
```

Enterprise policy may force relay.

### 10.4 Multiparty

Do not implement mesh beyond a deliberately small development experiment.

Initial production multiparty design uses an SFU, with LiveKit as the reference implementation candidate.

Business semantics must not depend on media topology.

## 11. WebRTC data channels

### cursor-fast

```text
unordered
loss-tolerant
latest-event-wins
```

Events:

```text
cursor.move
cursor.presence
cursor.hover
```

### input-reliable

```text
ordered
reliable
```

Events:

```text
pointer.down
pointer.up
pointer.click
pointer.wheel
key.down
key.up
control.grant
control.revoke
lease.acquire
lease.release
```

### annotation-fast

Loss-tolerant where possible.

```text
stroke.begin
stroke.points
stroke.end
```

## 12. Adaptive quality

Do not replace WebRTC congestion control.

Application-level quality modes guide encoder constraints:

```text
DETAIL
INTERACTIVE
MOTION
CONSTRAINED
```

Example preference:

- DETAIL: preserve text resolution, lower FPS acceptable;
- INTERACTIVE: 20-30fps, low buffering;
- MOTION: 30-60fps, resolution may drop;
- CONSTRAINED: aggressively protect freshness and input responsiveness.

Collect at least:

- RTT;
- send bitrate;
- estimated available bitrate where exposed;
- packet loss;
- NACK/retransmit counts;
- frames encoded/dropped;
- encode time;
- FPS;
- current resolution;
- quality limitation reason.

Use hysteresis. Never oscillate quality every sample window.

## 13. Security boundaries

### 13.1 Electron

- renderer is unprivileged;
- context isolation enabled;
- no Node integration in renderer;
- narrow typed preload API;
- validate all IPC payloads.

### 13.2 Native input helper

Remote input injection is performed by a separate local native helper.

Renderer never obtains arbitrary OS input-injection access.

Communication is via authenticated local IPC (Unix domain socket / named pipe / platform equivalent).

### 13.3 Remote-control safety

Mandatory:

- unmistakable "remote control enabled" indicator;
- one-click revoke;
- global emergency-revoke shortcut;
- stuck-key/button cleanup on disconnect;
- presenter physical input priority;
- no keystroke contents in audit logs.

### 13.4 Audit

Audit:

- layup created/ended;
- participant joined/left;
- invite/knock lifecycle;
- screen share started/stopped;
- drawing enabled/disabled;
- remote control granted/revoked;
- policy denied action.

Never audit:

- typed content;
- clipboard contents;
- screen pixels;
- raw cursor coordinates;
- audio/video contents.

## 14. Enterprise self-hosting

Minimum deployment:

```text
reverse proxy/TLS
Go control service
coturn
```

Optional persistence initially:

```text
PostgreSQL
```

Avoid Redis until clustering/presence fan-out requires it.

Requirements:

- fully self-hosted core operation;
- no mandatory vendor SaaS call;
- internal CA support;
- private RFC1918 deployment;
- configurable STUN/TURN;
- forced-relay mode;
- Prometheus metrics;
- structured logs;
- configurable retention;
- offline/air-gapped mode.

## 15. Enterprise policy precedence

Policy precedence is:

```text
organisation policy
    -> personal preference
        -> layup creation setting
            -> current presenter safety override
```

Example organisation policy:

```yaml
media:
  camera_on_join: true
  microphone_on_join: true
  auto_mute_threshold: 5

collaboration:
  drawing_default: true
  remote_control_default: true
  remote_control_allowed: true

layups:
  organisation_open_rooms_allowed: true
  link_rooms_allowed: true
```

## 16. Performance targets

These are engineering targets, not contractual guarantees.

### LAN

```text
screen glass-to-glass p50 < 80ms
screen glass-to-glass p95 < 150ms
control event network RTT p50 < 30ms
cursor presentation target 60Hz where practical
```

### Same-region Internet

```text
screen glass-to-glass p50 < 120ms
screen glass-to-glass p95 < 250ms
control network RTT p50 < 80ms
```

### Behavioural target

Under bandwidth reduction, degrade resolution/FPS before allowing seconds of stale video queue to accumulate.

## 17. Staged implementation

### Stage 0 - Foundation + measurement

Deliver:

- Electron shell;
- React renderer;
- secure preload bridge;
- Go service;
- shared protocol version;
- structured logs;
- CI;
- smoke test;
- latency/benchmark harness skeleton.

Gate: all supported targets compile and desktop can reach server health endpoint.

### Stage 1 - Layup domain + people/presence skeleton

Deliver:

- user/organisation/layup/membership domain models;
- membership-scoped creator privileges;
- presence WebSocket;
- People grid using fake/local identities first;
- layup create/join/leave;
- creator privilege devolution tests;
- no media yet.

Gate: two clients can see presence and join/leave the same logical layup; creator leaves and no privilege transfers/reappears.

### Stage 2 - Local capture + first remote screen

Deliver:

- screen/window picker;
- local capture preview;
- WebRTC signalling;
- P2P screen stream;
- TURN support;
- connection diagnostics.

Gate: two real machines connect on LAN, ordinary NAT and forced TURN.

### Stage 3 - Invitations, knocks, open layups

Deliver:

- invite available person;
- knock private layup;
- request expiry/cancel/decline;
- duplicate collapse;
- organisation-open layup discovery;
- link join;
- menu/tray attention state;
- "Join theirs / Invite them here / Decline" handling.

Gate: core People -> Layup social loop works without manual room codes.

### Stage 4 - Multi-cursor + drawing

Deliver:

- synthetic cursors;
- normalised coordinates;
- cursor interpolation;
- drawing protocol;
- presenter drawing toggle;
- capability checks.

Gate: four synthetic participants can move cursors/draw without materially degrading screen stream.

### Stage 5 - Remote mouse/keyboard control

Deliver:

- native helper boundary;
- macOS + Windows injection first;
- pointer/keyboard leases;
- presenter control toggle;
- individual revocation;
- emergency kill switch;
- stuck-key cleanup.

Gate: guest can operate a real editor while host can revoke instantly.

### Stage 6 - Audio/video + layup UX

Deliver:

- mic/camera;
- 1-4 unmuted default;
- 5+ join muted rule;
- device settings;
- participant strip/grid;
- no-screen shared social state;
- leave/rejoin;
- screen takeover behaviour.

Gate: normal 2-5 person layup is usable as a daily collaboration tool.

### Stage 7 - Adaptive quality + network hardening

Deliver:

- WebRTC stats;
- quality state machine;
- bitrate/resolution/FPS adaptation;
- network impairment suite;
- reconnect/ICE restart;
- interface change tests.

Gate: calls degrade gracefully under throttling/loss without runaway latency.

### Stage 8 - Enterprise self-hosting

Deliver:

- container images;
- Compose;
- coturn;
- PostgreSQL persistence;
- TLS/internal CA;
- air-gap verification;
- metrics;
- policy config.

Gate: two endpoints communicate using only enterprise-controlled infrastructure.

### Stage 9 - Multiparty via SFU

Deliver:

- LiveKit spike and ADR;
- screen/audio/video publication;
- data-channel semantics preserved;
- up to 10 participants target.

Gate: adding participant 10 does not multiply presenter upload by ten.

### Stage 10 - Enterprise identity + polish

Deliver:

- OIDC;
- organisation directory;
- admin policy;
- audit retention;
- Slack/Teams deep-link integrations later;
- broader Linux/Wayland hardening.

## 18. MVP definition

The first genuinely compelling internal MVP ends at Stage 5 plus minimal audio/video from Stage 6:

```text
open app
-> see people
-> click Karl
-> Karl accepts
-> layup forms
-> audio/video active according to policy
-> share screen
-> independent cursors
-> drawing
-> grant control
-> Karl types/clicks/drags
-> revoke instantly
```

The first enterprise deployable beta requires Stages 0-8.
