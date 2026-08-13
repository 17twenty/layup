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
6. `STATUS.md` - current execution state.
7. `PLAN-2.md` - provisional future plan. **Do not execute it yet.**

`PLAN-1-REVIEW.md` is the human review template used when PLAN-1 is complete. PLAN-2 is rewritten only after that review.

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

## Repository shape

```text
.
├── AGENTS.md
├── README.md
├── SPEC.md
├── ARCHITECTURE.md
├── PLAN-1.md
├── PLAN-2.md
├── PLAN-1-REVIEW.md
├── RALPH.md
├── TASKS.yaml
├── STATUS.md
├── REFERENCES.md
├── apps/
│   └── desktop/
├── services/
│   └── control/
├── native/
│   └── input-helper/
├── protocol/
├── deploy/
│   └── compose/
├── docs/
│   └── adr/
├── test/
│   ├── e2e/
│   ├── network/
│   └── latency/
├── benchmarks/
└── scripts/
```

The empty source directories are intentional. `P1-0001` bootstraps the actual toolchains so the agent does not inherit guessed package versions from this seed pack.
