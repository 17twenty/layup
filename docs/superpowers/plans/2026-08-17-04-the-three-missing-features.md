# The Three Missing Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All four things the dogfood session needs actually work: remote control, independent cursors, **drawing**, and a **visible connection readout** — plus the Accessibility onboarding that stops remote control failing silently.

**Architecture:** Almost none of this is invention. The drawing protocol (`protocol/ts/src/drawing.ts`), the `DrawingOverlay` component and the presenter safety toggle all exist and are tested; nothing opens the `annotation-fast` channel that `core/data-channels.ts:13` already declares and configures, and nothing imports the overlay outside its own test. Likewise `core/session.ts:241` computes route, candidate types and RTT and has no caller. This plan connects things that were built and never plugged in, then adds the one genuinely new piece: Accessibility permission onboarding modelled on the Screen Recording onboarding already in `main/permissions.ts`.

**Tech Stack:** TypeScript, React 19, Electron 43, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-two-person-dogfood-design.md`

## Global Constraints

- **Do not modify `protocol/ts/src/drawing.ts`.** It is complete and tested. Use `strokeBegin`, `strokePoints`, `strokeEnd`, `strokeClear`, `decodeDrawing` and `createStrokeAssembler` as they are.
- Strokes are normalised 0..1 coordinates, matching the overlay's viewBox and the cursor path's convention.
- Respect `MAX_POINTS_PER_MESSAGE` (64) and `MAX_POINTS_PER_STROKE` (4096).
- Drawing rides `annotation-fast` — unordered, `maxRetransmits: 2`, negotiated id 2. Never on `input-reliable`: a stale annotation is worse than a dropped one, and the reliable queue belongs to destructive input.
- Follow the existing cursor code as the pattern. `cursor-sender.ts` / `cursor-receiver.ts` are the shape to copy, including their tests.
- A remote participant may only draw when the presenter allows it. The check already exists — `GET /api/layups/{id}/share/drawing` and the P1-0408 safety toggle. Use it; do not add a second notion of permission.
- **Plan 03 Task 6 must have passed** before Task 4 here means anything.

---

### Task 1: A stroke sender

**Files:**
- Create: `apps/desktop/src/core/stroke-sender.ts`
- Create: `apps/desktop/src/core/stroke-sender.test.ts`

**Interfaces:**
- Consumes: `strokeBegin`, `strokePoints`, `strokeEnd`, `strokeClear`, `MAX_POINTS_PER_MESSAGE` from `@layup/protocol`; a `send(message: unknown) => void` sink.
- Produces: `createStrokeSender({ membershipId, colour, width, send }): StrokeSender` with `begin(point)`, `extend(point)`, `end()`, `clear()`, `drawing(): boolean`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { TYPE_STROKE_BEGIN, TYPE_STROKE_END, TYPE_STROKE_POINTS, MAX_POINTS_PER_MESSAGE } from '@layup/protocol';
import { createStrokeSender } from './stroke-sender';

const sender = (send = vi.fn()) => ({
  send,
  stroke: createStrokeSender({ membershipId: 'mem_1', colour: '#ff0000', width: 3, send }),
});

describe('the stroke sender', () => {
  it('announces a stroke before any points', () => {
    const { send, stroke } = sender();
    stroke.begin({ x: 0.1, y: 0.2 });
    expect(send.mock.calls[0][0]).toMatchObject({ type: TYPE_STROKE_BEGIN, membershipId: 'mem_1', colour: '#ff0000', width: 3 });
  });

  it('batches points rather than sending one message per pixel', () => {
    const { send, stroke } = sender();
    stroke.begin({ x: 0, y: 0 });
    send.mockClear();
    for (let i = 0; i < 10; i += 1) stroke.extend({ x: i / 100, y: i / 100 });
    // Ten mouse samples must not become ten datagrams.
    expect(send).not.toHaveBeenCalledTimes(10);
    stroke.end();
    const points = send.mock.calls.filter((call) => call[0].type === TYPE_STROKE_POINTS).flatMap((call) => call[0].points);
    expect(points).toHaveLength(10);
  });

  it('never exceeds the protocol\'s points-per-message limit', () => {
    const { send, stroke } = sender();
    stroke.begin({ x: 0, y: 0 });
    for (let i = 0; i < MAX_POINTS_PER_MESSAGE * 3; i += 1) stroke.extend({ x: 0.5, y: 0.5 });
    stroke.end();
    for (const [message] of send.mock.calls) {
      if (message.type === TYPE_STROKE_POINTS) expect(message.points.length).toBeLessThanOrEqual(MAX_POINTS_PER_MESSAGE);
    }
  });

  it('flushes the tail on end so the last of a stroke is never lost', () => {
    const { send, stroke } = sender();
    stroke.begin({ x: 0, y: 0 });
    stroke.extend({ x: 0.9, y: 0.9 });
    stroke.end();
    const types = send.mock.calls.map((call) => call[0].type);
    expect(types).toContain(TYPE_STROKE_POINTS);
    expect(types[types.length - 1]).toBe(TYPE_STROKE_END);
  });

  it('ignores points that arrive without a stroke having begun', () => {
    const { send, stroke } = sender();
    stroke.extend({ x: 0.5, y: 0.5 });
    expect(send).not.toHaveBeenCalled();
    expect(stroke.drawing()).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test --workspace apps/desktop -- stroke-sender`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

Mirror `cursor-sender.ts`: a stroke id from `crypto.randomUUID()`, a point buffer flushed on `requestAnimationFrame` (injectable for tests) or when it reaches `MAX_POINTS_PER_MESSAGE`, and a hard stop at `MAX_POINTS_PER_STROKE`. `end()` flushes then sends `strokeEnd`. `clear()` sends `strokeClear`.

- [ ] **Step 4: Run green**

Run: `npm test --workspace apps/desktop -- stroke-sender`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/core/stroke-sender.ts apps/desktop/src/core/stroke-sender.test.ts
git commit -m "desktop: something to send a stroke with"
```

---

### Task 2: Open the third channel

**Files:**
- Modify: `apps/desktop/src/renderer/layup/useLayupRoom.ts:75-105`
- Modify: `apps/desktop/src/renderer/layup/useLayupRoom` tests (or create alongside)

**Interfaces:**
- Consumes: `createStrokeSender` (Task 1), `createStrokeAssembler` and `decodeDrawing` from `@layup/protocol`, `CHANNEL_ANNOTATION` from `core/data-channels`.
- Produces, on `LayupRoom`: `strokes: AssembledStroke[]`, `beginStroke(point)`, `extendStroke(point)`, `endStroke()`, `clearStrokes()`, `canDraw: boolean`.

- [ ] **Step 1: Write the failing test**

```typescript
it('subscribes to the annotation channel when a peer appears', () => {
  // The wire() callback currently registers cursor-fast and input-reliable
  // only. Assert annotation-fast is registered too.
});

it('assembles a remote peer\'s stroke into something drawable', () => {
  // Feed begin -> points -> end through the channel handler and expect one
  // AssembledStroke with the points in order.
});

it('drops a malformed drawing message without breaking the overlay for everyone', () => {
  // decodeDrawing throws; the room must survive it, exactly as the cursor
  // receiver already does.
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test --workspace apps/desktop -- useLayupRoom`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `wire()`, beside the two existing subscriptions:

```typescript
    channels.on(CHANNEL_ANNOTATION, (message) => {
      try {
        assemblerRef.current.apply(decodeDrawing(message));
        setStrokes(assemblerRef.current.strokes());
      } catch {
        // One peer sending nonsense must not clear everybody's annotations.
      }
    });
```

Add an `assemblerRef` from `createStrokeAssembler()`, a `strokes` state, and a `strokeSenderRef` built when the local membership and identity colour are known — broadcasting to every peer's annotation channel, the way the cursor sender already does.

- [ ] **Step 4: Run green**

Run: `npm test --workspace apps/desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/layup
git commit -m "desktop: open the channel that was declared and never used"
```

---

### Task 3: Draw on the shared screen

**Files:**
- Modify: `apps/desktop/src/renderer/layup/LayupRoom.tsx:290-320`
- Modify: `apps/desktop/src/renderer/shell/CallControls.tsx`
- Modify: `apps/desktop/src/renderer/layup/LayupRoom.test.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`

**Interfaces:**
- Consumes: the room API from Task 2.
- Produces: a Draw toggle, and `DrawingOverlay` mounted over the shared screen — its first use anywhere outside its own test.

- [ ] **Step 1: Write the failing test**

```tsx
it('shows a draw toggle when a screen is being shared', () => { /* ... */ });

it('draws over the shared screen rather than beside it', () => {
  // DrawingOverlay renders in the same stacking context as CursorOverlay.
});

it('turns a drag into a stroke, in normalised coordinates', () => {
  // pointerdown at the centre of a 800x600 surface -> beginStroke({x:0.5,y:0.5})
});

it('offers no draw toggle when the presenter has disabled drawing', () => {
  // canDraw false -> no toggle, and pointer events do not begin a stroke.
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test --workspace apps/desktop -- LayupRoom`
Expected: FAIL.

- [ ] **Step 3: Implement**

Mount `<DrawingOverlay strokes={room.strokes} identify={room.identify} />` in the same overlay slot as `CursorOverlay` at `LayupRoom.tsx:306`. Add a Draw toggle to `CallControls` following the existing icon-button pattern. When drawing is active, `pointerdown`/`pointermove`/`pointerup` on the shared-screen surface map to `beginStroke`/`extendStroke`/`endStroke` using the same normalisation `moveCursor` already uses. Drawing mode suppresses remote-input forwarding while active — a stroke is not a click.

- [ ] **Step 4: Run green**

```bash
npm test --workspace apps/desktop && make check
```

Expected: PASS and green.

- [ ] **Step 5: Verify with two clients by hand**

Two desktops in a layup with a screen shared. Both draw. Both see both sets of strokes, in each author's cursor colour. The presenter's drawing toggle removes the ability.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer
git commit -m "desktop: draw on the screen, in the colour you already are"
```

---

### Task 4: Say what the connection is doing

**Files:**
- Create: `apps/desktop/src/renderer/layup/ConnectionReadout.tsx`
- Create: `apps/desktop/src/renderer/layup/ConnectionReadout.test.tsx`
- Modify: `apps/desktop/src/renderer/layup/useLayupRoom.ts`
- Modify: `apps/desktop/src/renderer/layup/LayupRoom.tsx`

**Interfaces:**
- Consumes: `session.diagnostics()` (`core/session.ts:241`), which currently has no caller anywhere in the application.
- Produces: `LayupRoom.diagnostics: Record<string, RouteDiagnostics>`, refreshed every 2000 ms, and a `<ConnectionReadout />` component.

- [ ] **Step 1: Write the failing test**

```tsx
it('names the route in words rather than jargon', () => {
  // route "relay" -> "Relayed"; "direct" -> "Direct"
});

it('shows the round trip in milliseconds', () => { /* rtt 34 -> "34 ms" */ });

it('says it is still working out the route rather than showing nothing', () => {
  // undefined diagnostics -> "Connecting…", never an empty box
});

it('marks a relayed route as worth knowing about', () => {
  // Relay is not an error, but it explains latency, so it is visually distinct.
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test --workspace apps/desktop -- ConnectionReadout`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `useLayupRoom`, a `setInterval` of 2000 ms calling `sessionRef.current?.diagnostics()` into state, cleared on unmount. `ConnectionReadout` renders route, RTT and the local/remote candidate types, plus the incoming video's resolution and framerate where the track's `getSettings()` exposes them. Place it in the layup's chrome — small, always visible while sharing.

- [ ] **Step 4: Run green**

Run: `npm test --workspace apps/desktop && make check`
Expected: PASS.

- [ ] **Step 5: Verify it tells the truth**

Run two desktops against the deployed server. Confirm the readout says `Direct` normally. Then set `LAYUP_FORCE_RELAY=true` in `/etc/layup/control.env`, `make deploy`, reconnect, and confirm it says `Relayed`. **A readout that cannot distinguish those two is worse than none** — it would make the session's verdict confidently wrong. Set it back to `false` afterwards.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/layup
git commit -m "desktop: say which way the connection went, and how far"
```

---

### Task 5: Ask for Accessibility the way we ask for screen recording

**Files:**
- Modify: `apps/desktop/src/main/permissions.ts`
- Modify: `apps/desktop/src/main/permissions.test.ts`
- Modify: `apps/desktop/src/renderer/layup/RemoteControlPanel.tsx`
- Modify: `apps/desktop/src/shared/ipc.ts`, `src/preload/api.ts`, `src/main/ipc.ts`

**Interfaces:**
- Consumes: `HelperState.capabilities` from `main/helper-supervisor.ts`.
- Produces: `PermissionService.accessibility(): AccessibilityPermission` with the same shape as `capture()` — `{ status, canInject, guidance, canOpenSettings, platform }` — and `openAccessibilitySettings()`.

- [ ] **Step 1: Write the failing test**

```typescript
it('reports accessibility as granted when the helper says it can inject', () => { /* ... */ });

it('explains what to do when the helper cannot inject', () => {
  // guidance must name Privacy & Security -> Accessibility and mention Layup by
  // name, matching the tone of the screen-recording guidance.
});

it('deep-links to the accessibility pane', async () => {
  expect(MACOS_ACCESSIBILITY_SETTINGS_URL)
    .toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

it('does not claim accessibility is required off macOS', () => {
  // platform 'win32' -> 'not-required'
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test --workspace apps/desktop -- permissions`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `MACOS_ACCESSIBILITY_SETTINGS_URL` and an `accessibility()` method built from the helper's reported capabilities rather than from `systemPreferences` — the helper's `AXIsProcessTrusted` is the authoritative answer, and it is the process that will actually post the event. Surface it in `RemoteControlPanel` so that granting Mouse when the helper cannot inject shows the guidance and an **Open Settings** button instead of a switch that appears to work.

This is the failure the helper's own source calls the worst available: the guest clicks, and the presenter's machine silently ignores it.

- [ ] **Step 4: Run green**

```bash
npm test --workspace apps/desktop && make check && make test-boundary
```

Expected: PASS, green, `BOUNDARY OK`.

- [ ] **Step 5: Verify on a machine with the grant revoked**

Remove Layup from Accessibility, relaunch, and try to grant Mouse. Expect the guidance and the button, not a silent no-op.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src
git commit -m "desktop: never let remote control fail quietly"
```

---

### Task 6: The dress rehearsal

**Files:**
- Modify: `PLAN-1-REVIEW.md`
- Modify: `STATUS.md`

- [ ] **Step 1: Run the twelve-row journey end to end**

Two Macs, different networks, both on the notarised build from plan 03. Walk every row of `PLAN-1-REVIEW.md` §3: launch → see colleague → click → accept → AV → share → cursors → drawing → remote mouse → remote keyboard → emergency revoke → presenter stops, layup survives → creator leaves, authority devolves.

- [ ] **Step 2: Fill in what is true**

Complete §3 and §7 (macOS) of `PLAN-1-REVIEW.md` with what happened, including the friction column. Leave §4 empty and say why: the benchmark harness has only `synthetic-latency` and `loopback-rtt`, neither of which touches media, so there are no glass-to-glass numbers to record and inventing them would be worse than the gap.

- [ ] **Step 3: Update STATUS.md**

Record that the deployed environment exists, what the dogfood found, and which of the previously-blocked items (P1-0312's two real machines) this session now unblocks.

- [ ] **Step 4: Commit**

```bash
git add PLAN-1-REVIEW.md STATUS.md
git commit -m "review: what the twelve rows actually did"
```

---

## Done when

- Both people can draw on the shared screen and see each other's strokes.
- The connection readout distinguishes `Direct` from `Relayed`, proven by forcing relay and watching it change.
- Granting Mouse without the Accessibility permission explains itself instead of doing nothing.
- `make check`, `make test-boundary` and `make test-e2e` are green.
- `PLAN-1-REVIEW.md` §3 is filled in from a real session, with §4 honestly left empty.
