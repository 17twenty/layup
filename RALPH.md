# Ralph Loop Contract

You are the implementation loop for Layup.

Complete **exactly one eligible task per invocation**, then exit.

## 1. Authority hierarchy

Read these as different kinds of authority:

1. `SPEC.md` - product invariants and behavioural truth.
2. `ARCHITECTURE.md` - technical/trust boundaries.
3. `PLAN-1.md` - current executable plan.
4. `TASKS.yaml` - atomised authorised work.
5. `STATUS.md` - current execution facts.
6. ADRs referenced by the selected task.

`PLAN-2.md` is **provisional and non-executable**. It must never be used as a source of tasks during PLAN-1.

If these sources materially contradict one another, stop and mark the selected task blocked rather than choosing your favourite interpretation.

## 2. Mandatory read order

Before editing:

1. `SPEC.md`
2. `ARCHITECTURE.md`
3. `PLAN-1.md`
4. `TASKS.yaml`
5. `STATUS.md`
6. any ADR referenced by the selected task

## 3. Task selection

Choose the first task in file order where:

- `plan: PLAN-1`;
- `status: todo`;
- every ID in `depends_on` is `done`.

Do not skip ahead.

If no task is eligible:

- if unfinished tasks are blocked, summarise the dependency dead-end in `STATUS.md` and exit;
- if all PLAN-1 tasks are done, write `PLAN-1 GATE READY` and the exact verification/evidence locations to `STATUS.md`, then exit;
- never create PLAN-2 tasks yourself.

## 4. One-task scope

Implement only the selected task.

Obey the task's:

- `goal`;
- `user_visible_behaviour`;
- `depends_on`;
- `allowed_paths`;
- `non_goals`;
- `forbidden`;
- `protocol_changes`;
- `security`;
- `acceptance`;
- `performance`;
- `observability`;
- `definition_of_done`.

You may make minimal shared fixture/test changes required to prove the task. Do not opportunistically complete future tasks.

## 5. Architecture guardrails

Unless the selected task explicitly authorises it, never:

- add an SFU;
- add LiveKit;
- proxy 1:1 media through the Go control service;
- add Redis/Kafka/NATS/RabbitMQ;
- add production persistence merely for convenience;
- implement TURN/STUN yourself;
- fork Chromium;
- add a custom congestion controller;
- add custom native capture/encoding;
- enable Node integration in the Electron renderer;
- give the renderer direct OS input-injection access;
- add a transferable moderator/host role;
- elect a replacement creator;
- restore creator privilege when the original user rejoins;
- add simultaneous multi-screen sharing;
- persist raw keystrokes, clipboard contents, screen pixels, audio/video contents or raw cursor trails;
- implement literal layup graph merging.

## 6. Non-negotiable domain invariant

Creator privilege belongs to an incarnation-specific `Membership.id`.

When that membership leaves:

```text
creator privilege disappears forever
no one inherits it
layup may continue
same User rejoins via a new ordinary Membership
```

Reject any implementation that violates this even if existing tests fail to cover it.

## 7. Test-before / test-after loop

For the chosen task:

1. Run relevant existing tests before editing.
2. Record pre-existing relevant failures in `STATUS.md`.
3. Implement the smallest complete change.
4. Add/update automated tests for every automatable acceptance criterion.
5. Run relevant unit tests.
6. Run relevant integration/e2e tests.
7. Run lint/typecheck/build for touched components.
8. Run required performance checks.
9. Update task evidence/result in `TASKS.yaml` if fields are present.
10. Update `STATUS.md` concisely.
11. Set `status: done` only if Definition of Done is met.
12. Make one focused git commit if git is available.
13. Exit.

Never mark a task done because code "looks right".

## 8. Blocked tasks

Set `status: blocked` and stop if:

- acceptance conflicts with SPEC/ARCHITECTURE;
- a security boundary must be weakened;
- an undeclared architectural dependency is required;
- a public protocol must change incompatibly without authorisation;
- three materially different implementation attempts fail;
- a specified performance budget cannot be met within scope;
- platform/API behaviour makes acceptance impossible.

Append to `STATUS.md`:

```text
BLOCKED: <task id>
Reason:
Evidence:
Smallest human decision needed:
Options:
```

Do not fix a blocked architecture decision by silently widening scope.

## 9. PLAN-1 final gate

There are no automatic PLAN-2 transitions.

When all PLAN-1 tasks are done:

- write `PLAN-1 GATE READY` to `STATUS.md`;
- point to benchmark/e2e evidence;
- do not edit `PLAN-2.md`;
- do not mark `PLAN-1-REVIEW.md` as passed;
- do not create new tasks;
- exit.

Humans decide whether the product feels good enough and rewrite PLAN-2.

## 10. Status discipline

Keep `STATUS.md` useful, not diaristic.

Record:

- current task/result;
- test/build commands and result;
- key metrics;
- blocker if any;
- last 5 meaningful runs at most;
- PLAN-1 gate state.

## 11. Commit discipline

Prefer one focused commit per successful task:

```text
P1-0304: establish direct WebRTC peer connection
```

Do not bundle cleanup or unrelated refactors.
