# PLAN-1 Review

**Status: WAITING FOR PLAN-1 GATE**

Complete this with real evidence before PLAN-2 is rewritten or unlocked.

## 1. Gate result

- [ ] PASS - we would voluntarily use this to pair for an hour.
- [ ] CONDITIONAL - core magic exists but specific issues must be fixed before PLAN-2.
- [ ] FAIL - architecture/product assumptions need material rework.

Reviewer(s):

Date:

## 2. What was actually built

Summarise the shipped PLAN-1 path, not the intended one.

## 3. Product journey

Rate each step and record friction:

| Step | Result | Evidence / friction |
|---|---|---|
| Launch -> see colleague | | |
| Click -> invitation appears | | |
| Accept -> joined layup | | |
| AV starts correctly | | |
| Start screen share | | |
| Independent cursors | | |
| Drawing | | |
| Remote mouse | | |
| Remote keyboard | | |
| Emergency revoke | | |
| Presenter stops sharing, layup survives | | |
| Creator leaves, authority devolves to nobody | | |

## 4. Performance evidence

### Direct/LAN

- screen glass-to-glass p50:
- screen glass-to-glass p95:
- input RTT p50/p95:
- capture/encode notes:
- CPU/memory:

### Ordinary Internet/NAT

- screen glass-to-glass p50:
- screen glass-to-glass p95:
- input RTT p50/p95:
- ICE route:
- CPU/memory:

### Forced TURN

- screen glass-to-glass p50:
- screen glass-to-glass p95:
- input RTT p50/p95:
- relay transport:
- CPU/memory:

## 5. One-hour dogfood

Participants:

What task did we pair on?

What made us notice the tool?

What made us want to stop using it?

Any crash/reconnect/permission issue?

Would we use it tomorrow? Why/why not?

## 6. Architecture scorecard

| Decision | Validated / Changed / Rejected | Evidence |
|---|---|---|
| Electron capture first | | |
| Chromium/WebRTC encoding | | |
| Go control plane | | |
| P2P first | | |
| coturn fallback | | |
| synthetic cursors | | |
| data-channel split | | |
| native input helper | | |
| pointer/keyboard leases | | |
| no moderator role | | |
| membership-scoped creator privilege | | |
| single active screen share | | |

## 7. Platform findings

### macOS

Permissions, scaling, multiple displays, sleep/wake, input injection:

### Windows

DPI, UAC/integrity, multiple displays, keyboard layouts, sleep/wake:

### Linux

What was proven versus deferred:

## 8. Product findings

- People/presence:
- Invitations/knocks:
- Open layups/Happening Now:
- AV defaults:
- screen takeover:
- cursors:
- drawing:
- remote control:

## 9. Technical debt consciously accepted

List only debt we knowingly choose to carry.

## 10. PLAN-2 changes required

### Keep

### Change

### Delete

### Add

## 11. Decision

Who is authorised to rewrite/unlock PLAN-2?

Decision notes:
