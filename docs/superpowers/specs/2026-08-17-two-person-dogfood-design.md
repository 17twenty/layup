# Two-person dogfood: design

Status: accepted 2026-08-17
Supersedes nothing. Sits ahead of the PLAN-1 gate and feeds it.

## 1. Goal

Two people, on two Macs, on different networks, pair for an hour and form an
honest opinion about whether Layup has any magic in it.

Everything in this document exists to make that hour happen and to make its
verdict trustworthy. Work that does not serve it is out of scope, however
defensible it is on its own terms.

Four things must work in the room, and they were chosen deliberately:

- remote mouse and keyboard - the thesis; without it this is a screen share;
- independent cursors - already working, needs only to survive real latency;
- drawing - built and tested, entirely unwired;
- a visible connection readout - so a laggy hour produces a diagnosis rather
  than a mood.

### Non-goals

Multiparty. Real identity providers. Persistence of layups. Windows. An SFU.
Adaptive quality control. Anything PLAN-2 already owns. We are not completing
PLAN-1 here; we are getting to the one session that tells us whether PLAN-1 was
worth completing.

## 2. What is true today

Verified by reading the tree on 2026-08-17, not inferred from the plan
documents.

Working end to end: presence, invitation, accept, layup, audio/video, screen
share, independent cursors, screen takeover, creator devolution. `make check`
is green - 366 renderer and core tests, 33 protocol tests, every Go module,
and every component builds.

Gaps that matter, each confirmed in the source:

- **Drawing is unwired.** `renderer/layup/DrawingOverlay.tsx` is imported by
  nothing outside its own test. `core/data-channels.ts:13` declares and
  configures `annotation-fast`; `renderer/layup/useLayupRoom.ts` opens
  `cursor-fast` and `input-reliable` only. Nothing sends a stroke.
- **The input helper is never built or placed.** `main/index.ts:191` looks for
  `LAYUP_HELPER_BINARY` or `<resourcesPath>/layup-input-helper`. No Makefile
  target produces that binary, no documentation mentions the variable, and the
  string appears exactly once in the repository - in the line that reads it.
- **Diagnostics have no consumer.** `core/session.ts:241` computes route,
  candidate types and RTT. Nothing in the renderer calls it.
- **Accessibility has no onboarding.** `main/permissions.ts` handles Screen
  Recording properly - status, plain-language guidance, a deep link to the
  settings pane. There is no equivalent for Accessibility, whose failure mode
  the helper's own comments identify as the worst available: the guest clicks
  and the presenter's machine silently ignores it.
- **No persisted state, anywhere.** The desktop never calls
  `app.getPath('userData')`. The control service writes nothing to disk.
- **No packaging and no deep-link handling.** No electron-builder, no
  `setAsDefaultProtocolClient`.
- **The control service has no authentication.** `X-Layup-Dev-User: karl` makes
  you Karl (`httpapi/identity.go:40`). Correct on loopback, unacceptable on a
  public host.

## 3. The environment

`layup.blah.au` resolves to `157.20.113.124`. Apex only; no wildcard.

Debian 12, x86_64, 4 cores, 3.9 GB RAM, 24 GB free. The public IP sits directly
on `eth0` (`157.20.113.124/25`) with no NAT in front. Bare: no Docker, no web
server, only sshd listening. iptables policy is ACCEPT with no rules.

That the address is un-NATted matters: coturn can bind and advertise it without
`--external-ip` translation, which removes the most common source of silent
TURN failure.

## 4. Deployment: native systemd

`deploy/compose/docker-compose.yml` stays in the repository as the
self-hostable story for SPEC §14. It is not how this environment runs.

Rationale: Docker is not installed; coturn's relay port range through Docker's
userland proxy adds latency and drops allocations, which corrupts the one thing
this session measures; and an un-NATted public IP is precisely the case where
containerised TURN buys nothing.

- **Caddy** on 443. Automatic Let's Encrypt for `layup.blah.au`. Terminates
  TLS, reverse-proxies to the control service on `127.0.0.1:8787` with the
  WebSocket upgrade passed through, and serves the join page and the DMG from
  disk.
- **coturn** from apt, host networking, `--use-auth-secret` with the same
  shared secret the control service uses to mint REST credentials. UDP 3478
  primary, TCP 3478 as a fallback for hostile networks. Relay range
  49160-49200/udp.
- **Control service** cross-compiled on the Mac (`GOOS=linux GOARCH=amd64`),
  copied over, run by systemd as a non-root user. No Go toolchain on the VM.
- **nftables**, default drop, permitting 22, 443, 3478 tcp and udp, and
  49160-49200/udp.
- **`make deploy`** builds, uploads and restarts. Deployment is a command, not
  a memory exercise.

## 5. Identity: adding a server is the whole of it

### The flow

First run shows one screen. Server, code, your name, Connect.

Connect registers with the control service, receives an identity and a
long-lived token, writes it to `app.getPath('userData')`, and lands on the
People grid. From that moment the person is in the directory.

**That is also the presence setup, with no second step.** Presence fans out
over `directory.Users()` (`presencefeed/feed.go:119`) and the People grid reads
the same source through `GET /api/directory`. Both already sit behind the
`Directory` interface, constructed in exactly one place
(`httpapi/server.go:65`). A dynamic directory therefore lights up presence and
the grid at once - a new implementation behind an existing seam, not a rework.

### The join code

A single long-lived code, set as `LAYUP_JOIN_CODE` in the server's
environment. Without it, anyone
who finds `layup.blah.au` registers into the organisation and appears in the
People grid, on a box that will have a screen share running on it.

It is deliberately not per-person tokens: minting, tracking and expiring them
is machinery a two-person test does not need. `httpapi/links.go` already
demonstrates the token-store pattern if that changes later.

### The link is the same form, pre-filled

`https://layup.blah.au/join/<code>` serves a page offering the download and a
`layup://` deep link carrying server and code, leaving only the name to type.
One flow and one code path; the link is convenience, not a second mechanism.

The app also accepts the code pasted by hand. This is not optional politeness:
a `layup://` link fails confusingly when macOS has not yet registered the
handler, which is exactly the state the other person's Mac is in the first time
they click it.

### Wire changes

- `POST /api/register` with `{ code, displayName }` returns `{ token, user,
  organisation }`. The token does not expire: this is a two-person development
  environment, and revocation is deleting the store and re-registering. A TTL
  would only add a way for the session to fail halfway through.
- Every HTTP call carries `Authorization: Bearer <token>`.
- The WebSocket carries the token as a **query parameter**, mirroring the
  existing `QueryDevUser` (`protocol/go/realtime.go:25`), because
  `core/realtime-client.ts:86` uses the plain `WebSocket` global, which cannot
  set headers. This is safe only because TLS terminates at Caddy, and only if
  the token never reaches a log. The repository's existing redaction discipline
  extends to cover it, with a test.
- `X-Layup-Dev-User` keeps working for loopback connections and when
  `LAYUP_ENV=dev`, so local development and the entire existing test suite are
  untouched.

### Persistence

The control service currently writes nothing to disk. Dynamic identities and
tokens must survive a restart or both people re-onboard on every deploy.

Only the identity and token table is persisted, as a JSON file. Layups,
memberships and presence stay in memory, because a restart genuinely does end a
live layup and pretending otherwise would be a lie told by the software.
ARCHITECTURE §10 holds: the domain does not learn about disk, one small store
does.

## 6. Desktop configuration

A `config` module in main owning `{ serverUrl, token, userId }` as JSON under
`app.getPath('userData')`; an Add-server screen in the renderer;
`setAsDefaultProtocolClient('layup')` and an `open-url` handler.

The control client reads configuration rather than `LAYUP_CONTROL_URL`.
Environment variables remain as an override, so local development and the smoke
and e2e harnesses keep working unchanged.

## 7. Packaging

Signed and notarised from the first build, not eventually.

The reason is specific rather than fastidious: **TCC grants are keyed to code
signing identity.** An unsigned or ad-hoc-signed app has its Screen Recording
and Accessibility grants keyed to the binary, so every rebuild resets both - and
Accessibility is what makes remote control work at all. Over a week of
iteration that is re-granting permissions in System Settings after every build,
on both machines, while trying to evaluate a product. Separately, macOS 15
removed the right-click-to-open bypass, so an unsigned download now requires a
trip through Privacy & Security by the person we are trying to impress.

- **electron-builder**, universal binary (arm64 + x64), DMG.
- **The Go helper is bundled inside the app** and signed with the same Team ID.
  This is what fixes remote control: a helper inside the bundle, signed by the
  same team, is attributed to the parent app by TCC, so one Accessibility grant
  on Layup covers it. The helper needs its own universal build - `lipo` over
  two `go build`s - and it needs cgo enabled, because
  `inject_darwin_nocgo.go` compiles cleanly and then declines to inject.
- **Entitlements and Info.plist:** hardened runtime;
  `com.apple.security.cs.allow-jit` and
  `com.apple.security.cs.allow-unsigned-executable-memory`, without which
  Electron will not launch; camera and microphone device entitlements; and
  `NSCameraUsageDescription` and `NSMicrophoneUsageDescription`, whose absence
  is not a missing prompt but a hard crash on the first `getUserMedia`.
- **Notarisation** via `notarytool`, then stapled.
- **Hosted** at `layup.blah.au` by the same Caddy, linked from the join page.
- **`make package`** and **`make release`**.

## 8. Feature wiring

**Drawing.** A stroke sender; open `annotation-fast` in `useLayupRoom`; mount
`DrawingOverlay` in `LayupRoom`; a draw toggle in `CallControls`. The protocol,
the overlay and the presenter safety toggle already exist and are tested. This
is wiring, not invention.

**Connection readout.** Poll `session.diagnostics()` every two seconds and
surface route, RTT, resolution and framerate unobtrusively. Without it, a laggy
hour cannot be attributed to relay, network or encoder, and the verdict is a
feeling instead of a finding.

**Accessibility onboarding.** Extend `main/permissions.ts` to check
Accessibility as it already checks Screen Recording - status, plain-language
guidance, a deep link to the settings pane - and surface the helper's own
`AXIsProcessTrusted` report in the interface. The silent failure this prevents
is the one the helper's source already names as the worst available.

## 9. Testing

The existing discipline continues: unit tests alongside each change,
`make check` green before anything ships, and the real-boundary harnesses
(`test-boundary`, `test-webrtc`, `test-e2e`, `test-smoke`) unbroken.

New coverage that is genuinely load-bearing:

- registration and token authentication, including rejection of a bad code and
  of a missing or forged token, in `httpapi`;
- the dynamic directory, including that a registered user appears in
  `Users()` and therefore in presence;
- token redaction - the token never reaches a log, matching the existing
  "typed content is never logged" test;
- persistence round-trip: identities and tokens survive a restart, layups do
  not;
- the annotation channel end to end, in the same style as the cursor tests;
- desktop config round-trip and deep-link parsing, including a malformed link.

`make test-turn` gains a mode that points at the real coturn on the VM rather
than a container, which converts the deployment from "it started" into "it
relays".

## 10. Risks

**The notarised app plus bundled helper may not get Accessibility attributed as
intended.** This is the assumption the whole remote-control path rests on. It
is verified as early as possible: the first packaged build that exists is
tested for one injected click before any feature work depends on it.

**TURN between two real networks is unproven.** Everything to date is
single-machine or containerised. The relay path is verified against the
deployed coturn before the session is scheduled.

**A carrier-grade NAT on either side may force relay for everything**, which
changes what the hour measures. The connection readout is what makes this
visible rather than mysterious, which is part of why it is non-negotiable.

## 11. Deliberately not done

Per-person invitations. Layup persistence. Windows. An approval queue for
registration. Real authentication. Glass-to-glass latency instrumentation - the
benchmark harness has only `synthetic-latency` and `loopback-rtt`, neither of
which touches media, and building real instrumentation is PLAN-1 gate work that
this session should inform rather than precede.
