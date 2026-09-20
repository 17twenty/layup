# Web guests: design

Status: accepted 2026-08-17
Follows the two-person dogfood work. Extends, does not supersede,
`2026-08-17-two-person-dogfood-design.md`.

## 1. Goal

Someone with a link opens it in a browser, types a name, and is in the layup:
they see the shared screen, hear and are heard, are seen if they want to be, and
have a cursor the others can watch.

No install, no account, no org membership. The person sending the link is
already mid-call and wants a third pair of eyes now, not after an onboarding.

## 2. What a guest is, and is not

A guest **can**: receive the shared screen, receive and send audio and video, and
move a synthetic cursor others can see.

A guest **cannot**: draw, take or be granted remote mouse/keyboard control,
share their own screen, appear in anyone's People grid, see the directory,
discover other layups, or persist beyond the layup.

The rule behind those lines: a leaked link should cost you a spectator with a
microphone, never your machine and never your organisation. Both halves are
enforced on the server, not only in the client — a browser is the one client we
must assume is hostile, because it is the one a stranger is holding.

## 3. Why this is cheap

`apps/desktop/src/core/` imports nothing from Node or Electron. `session.ts`,
`peer-connection.ts`, `data-channels.ts`, `cursor-sender.ts`,
`cursor-receiver.ts`, `av.ts`, `devices.ts`, `ice-diagnostics.ts`,
`realtime-client.ts` and `control-client.ts` are all framework-free and run in a
browser unchanged. ARCHITECTURE §2's insistence that the renderer stay
unprivileged and the logic stay portable is what makes a web client small
instead of a rewrite.

`httpapi/links.go` already mints opaque 128-bit tokens scoped to a layup, with a
TTL and constant-time resolution. It is currently unused. Guests are what it was
for.

## 4. The domain: a guest is a membership without a directory entry

A guest is a `domain.User` with a `usr_g`-prefixed id, created on redemption and
held only in the layup's membership list. It is **never** returned by
`directory.Users()`.

That single exclusion does the work: presence fans out over `directory.Users()`
(`presencefeed/feed.go:119`) and the People grid reads the same source, so a
guest cannot appear in either without anyone writing code to prevent it.
Meanwhile membership is what layups, signalling and cursor identity key on, so
everything in the data plane works with no special cases.

Guests end with the layup. Nothing about them is persisted — they are not in
`identities.json`, and a restart does not resurrect them.

## 5. The link

One live link per layup, minted by a member from inside the call, alive as long
as the layup is, revocable at any time by any member.

- `POST /api/layups/{id}/link` mints or returns the current token.
- `DELETE /api/layups/{id}/link` revokes it. Existing guests stay; new ones are
  refused. Revoking is about the link, not about ejecting people.
- The layup ending destroys the token. That is the honest expiry: the thing the
  link points at no longer exists.

No TTL beyond the layup's own life. A short timer would expire a link
mid-session and send someone back to Slack to ask for another, which is exactly
the friction the feature exists to remove.

### Redemption, and a leak we have to close first

`POST /api/links/{token}/join` puts the token **in the URL path**. Caddy's access
log redacts query strings, not paths, so every guest token would be written to
`/var/log/caddy/layup.log` in cleartext. This was a deferred minor while the
endpoint was unused; it is load-bearing now.

Redemption moves to `POST /api/guest/join` with `{ token, displayName }` **in the
body**. The token never appears in a URL, a log, or a browser history entry.

The guest page is served at `/j/` and reads the token from the URL fragment
(`/j/#<token>`), which browsers never send to the server and Caddy therefore
cannot log.

## 6. Guest tokens are not bearer tokens

Redemption returns a **guest session token** bound to one layup and one
membership. It is not the bearer token a registered user holds.

Authorisation is an allow-list, not a deny-list: a guest token is accepted on
exactly the endpoints a guest needs —

```text
GET  /api/layups/{id}          the layup it was issued for, and no other
POST /api/layups/{id}/leave
GET  /api/turn                 or no NAT traversal, and no guest behind a router
GET  /api/realtime             signalling, scoped to that layup
```

— and rejected everywhere else with 403. A new endpoint is therefore closed to
guests by default, which is the only default that survives someone forgetting.

`authenticate()` already resolves bearer tokens through a `TokenResolver`
interface; guest sessions are a second resolver, returning a principal that
carries its layup scope. One place still decides who you are.

## 7. The web client

A new npm workspace `apps/web`: Vite, React, `@layup/protocol`, and
`apps/desktop/src/core` referenced through a Vite alias and a tsconfig path.

Extracting `core/` into a shared package is the correct long-term boundary and
is deliberately **not** done here. It means rewriting ~50 imports across a
desktop app whose suite has just gone green and shipped; an alias costs six
lines and risks nothing. Extract when a second stable consumer earns it.

What the web client does not have: `desktopCapturer`, the native input helper,
the IPC bridge, window modes, or any privileged process. It is `session.ts`
plus camera, microphone, a cursor and a video element — which is precisely the
unprivileged half the architecture already separated.

Served by the existing Caddy from `/srv/layup/public/j/`. No new infrastructure.

## 8. Media

The guest is another peer. Every existing participant opens a peer connection to
them exactly as they would to a desktop, over the same `cursor-fast` and
`input-reliable` channels; `annotation-fast` is not opened for guests, because
guests do not draw.

A mesh is right at this size and an SFU remains PLAN-2. Guests behind NAT reach
the same coturn every other participant uses, which is why `/api/turn` is on the
guest allow-list.

`input-reliable` still exists for a guest connection because the channel set is
negotiated, but the server refuses to issue a control grant naming a guest
membership, and `input-guard.ts` refuses one that arrives anyway. Two
independent refusals, because this is the one that matters.

## 9. Testing

- A guest token is refused on `/api/directory`, `/api/me`, `/api/layups`
  (list), and on any layup other than the one it was issued for.
- A registered user's bearer token is unaffected by any of it.
- A redeemed guest appears in the layup's participants and **not** in
  `directory.Users()` — asserted directly, because this is what keeps guests out
  of the People grid.
- A guest cannot be granted remote control: the server refuses to issue the
  grant, and `input-guard.ts` refuses the grant if it is fabricated.
- Revoking a link refuses new joins and does not disturb existing guests.
- Ending a layup invalidates the token and every guest session on it.
- The token appears in no log line, matching the existing redaction discipline.
- The web client builds, and `core/` compiles under a browser tsconfig with no
  Node types — a regression here means someone has put an Electron import in
  shared code.

## 10. Risks

**A browser is a hostile client.** Every guest limit is enforced server-side. The
client-side halves exist to make the UI honest, not to make it safe.

**Mesh fan-out.** Each guest adds a peer connection per participant. Fine at
three or four; visibly not fine at ten. The connection readout shipped in 0.2.1
is what will make that legible when it happens.

**A link pasted in a public channel.** Mitigated by revocation, by the layup's
own lifetime, and by the guest's narrow powers — not by secrecy alone.

## 11. Deliberately not done

Guest screen sharing. Guest drawing. Guest remote control. Windows or Linux
desktop parity. An SFU. Persisting guests. Naming guests before they arrive.
Extracting `core/` into a package.
