# Ralph prompt - PLAN-1.5

You have completed PLAN-1 and surfaced at its gate.

Before PLAN-2 can be reviewed, there is one required product-model addendum.

Read, in order:

1. `SPEC.md`
2. `ARCHITECTURE.md`
3. `PLAN-1.md`
4. `STATUS.md`
5. `PLAN-1.5.md`
6. `TASKS-1.5.yaml`
7. existing PLAN-1 People/presence implementation and tests

PLAN-1.5 intentionally supersedes the PLAN-1 assumption that the People grid is the raw organisation directory and that ordinary personal presence is broadcast organisation-wide.

The corrected model is:

```text
server directory = discoverable same-server identities
People = mutual accepted relationships
presence = normally shared with accepted People
open layups = separate room discovery surface
external person = invite them onto this server; no federation
```

Hard constraints:

- Do not implement federation.
- Do not implement global identities.
- Do not implement cross-server presence or relationships.
- Do not modify or execute PLAN-2.
- Do not reinterpret a server invite as federation.
- Keep People mutual, not one-way follows.
- Joining a server never automatically creates a People relationship.
- Preserve creator-devolution and presenter-sovereignty invariants from PLAN-1.

Execute exactly one eligible task from `TASKS-1.5.yaml` per invocation, update its status/evidence, update `STATUS.md`, run relevant tests, commit if possible, and exit.

When every PLAN-1.5 task is complete, write exactly:

```text
PLAN-1.5 GATE READY
```

to `STATUS.md` and stop.

Do not begin PLAN-2.
