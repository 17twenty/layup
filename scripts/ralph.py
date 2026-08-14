#!/usr/bin/env python3
"""Ralph's single entry point.

    python3 scripts/ralph.py            # what to do next
    python3 scripts/ralph.py status     # progress across both plans
    python3 scripts/ralph.py validate   # validate every task graph

There are two task files with different schemas and a lock between them:

    TASKS.yaml      PLAN-1    executable now
    TASKS-1.5.yaml  PLAN-1.5  locked until STATUS.md says PLAN-1 GATE READY

This script never merges them - that is a human decision (TASKS-1.5.yaml `rule`)
- and it never invents work. It reports which plan is live, which task is next,
and which contract document governs that task.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLAN1 = ROOT / "TASKS.yaml"
PLAN15 = ROOT / "TASKS-1.5.yaml"
STATUS = ROOT / "STATUS.md"

PLAN1_GATE = "PLAN-1 GATE READY"
PLAN15_GATE = "PLAN-1.5 GATE READY"

CONTRACTS = {
    "PLAN-1": "RALPH.md (+ PLAN-1.md, SPEC.md, ARCHITECTURE.md, docs/adr/)",
    "PLAN-1.5": "RALPH-PLAN-1.5-PROMPT.md (+ PLAN-1.5.md, SPEC.md, ARCHITECTURE.md)",
}

VALID_STATUS = {"todo", "in_progress", "done", "blocked"}

# PLAN-1 tasks are fully specified; PLAN-1.5 tasks are a lighter shape.
PLAN1_REQUIRED = [
    "id", "plan", "phase", "title", "status", "goal", "user_visible_behaviour",
    "depends_on", "allowed_paths", "non_goals", "forbidden", "protocol_changes",
    "security", "acceptance", "performance", "observability", "definition_of_done",
]
PLAN15_REQUIRED = ["id", "title", "status", "depends_on", "goal", "acceptance"]


def load_yaml(path: Path) -> dict:
    try:
        import yaml  # noqa: PLC0415 - optional dependency, reported clearly below
    except ModuleNotFoundError:
        sys.exit(
            "PyYAML is required.\n"
            "  python3 -m venv .venv && .venv/bin/pip install pyyaml\n"
            "  .venv/bin/python scripts/ralph.py"
        )
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text()) or {}


def gate_declared(marker: str) -> bool:
    """True only when STATUS.md *declares* a gate, on a line of its own.

    Substring matching is not enough: STATUS.md describes the plan sequence in
    prose, and mentioning a gate must never be mistaken for reaching one.
    """
    if not STATUS.exists():
        return False
    for line in STATUS.read_text().splitlines():
        if line.strip().strip("`*# ") == marker:
            return True
    return False


def plan15_unlocked() -> bool:
    """PLAN-1.5 becomes executable once PLAN-1 has surfaced at its gate."""
    return gate_declared(PLAN1_GATE)


def eligible(tasks: list[dict]) -> dict | None:
    """First task in file order whose dependencies are all done."""
    by_id = {task["id"]: task for task in tasks}
    for task in tasks:
        if task.get("status") != "todo":
            continue
        if all(by_id.get(dep, {}).get("status") == "done" for dep in task.get("depends_on", [])):
            return task
    return None


def counts(tasks: list[dict]) -> dict[str, int]:
    out = {state: 0 for state in VALID_STATUS}
    for task in tasks:
        out[task.get("status", "todo")] = out.get(task.get("status", "todo"), 0) + 1
    return out


def describe(task: dict, plan: str) -> str:
    phase = f" | phase {task['phase']}" if task.get("phase") else ""
    return (
        f"{task['id']}{phase} | {task['title']}\n"
        f"{task['goal']}\n\n"
        f"Contract: {CONTRACTS[plan]}\n"
        f"Task file: {'TASKS.yaml' if plan == 'PLAN-1' else 'TASKS-1.5.yaml'}"
    )


def cmd_next() -> int:
    plan1 = load_yaml(PLAN1).get("tasks", [])
    plan15 = load_yaml(PLAN15).get("tasks", [])

    task = eligible(plan1)
    if task:
        print(describe(task, "PLAN-1"))
        return 0

    unfinished = [t for t in plan1 if t.get("status") != "done"]
    if unfinished:
        # Nothing is eligible but work remains: a dependency dead end, which is
        # a human decision rather than something to route around.
        print("No eligible PLAN-1 task. Unfinished work is blocked or waiting on it:")
        for t in unfinished[:10]:
            print(f"- {t['id']}: {t.get('status')} deps={t.get('depends_on', [])}")
        print("\nSee the BLOCKED entry in STATUS.md for the decision needed.")
        return 2

    # Every PLAN-1 task is done.
    if not plan15_unlocked():
        print(f"All PLAN-1 tasks are done. Write `{PLAN1_GATE}` to STATUS.md and stop.")
        print("Humans complete PLAN-1-REVIEW.md before anything else runs.")
        return 0

    task = eligible(plan15)
    if task:
        print(describe(task, "PLAN-1.5"))
        return 0

    if any(t.get("status") != "done" for t in plan15):
        print("No eligible PLAN-1.5 task; the rest are blocked or waiting.")
        return 2

    print(f"All PLAN-1 and PLAN-1.5 tasks are done. Write `{PLAN15_GATE}` to STATUS.md and stop.")
    print("Do not begin PLAN-2.")
    return 0


def cmd_status() -> int:
    plan1 = load_yaml(PLAN1).get("tasks", [])
    plan15 = load_yaml(PLAN15).get("tasks", [])

    for label, tasks in (("PLAN-1", plan1), ("PLAN-1.5", plan15)):
        c = counts(tasks)
        lock = ""
        if label == "PLAN-1.5":
            lock = " [unlocked]" if plan15_unlocked() else " [locked until PLAN-1 GATE READY]"
        print(
            f"{label}{lock}: {c['done']}/{len(tasks)} done, "
            f"{c['todo']} todo, {c['in_progress']} in progress, {c['blocked']} blocked"
        )

    print(f"gate: PLAN-1 {'READY' if gate_declared(PLAN1_GATE) else 'not reached'}, "
          f"PLAN-1.5 {'READY' if gate_declared(PLAN15_GATE) else 'not reached'}")
    return 0


def validate_plan(tasks: list[dict], required: list[str], label: str) -> list[str]:
    errors: list[str] = []
    ids = [t.get("id") for t in tasks]
    if len(ids) != len(set(ids)):
        errors.append(f"{label}: duplicate task IDs")
    by_id = {t.get("id"): t for t in tasks}

    for index, task in enumerate(tasks):
        name = task.get("id", f"#{index}")
        for key in required:
            if key not in task:
                errors.append(f"{label} {name}: missing {key}")
        if task.get("status") not in VALID_STATUS:
            errors.append(f"{label} {name}: invalid status {task.get('status')!r}")
        for dep in task.get("depends_on", []):
            if dep not in by_id:
                errors.append(f"{label} {name}: unknown dependency {dep}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visited:
            return
        if node in visiting:
            errors.append(f"{label}: dependency cycle involving {node}")
            return
        visiting.add(node)
        for dep in by_id.get(node, {}).get("depends_on", []):
            if dep in by_id:
                visit(dep)
        visiting.discard(node)
        visited.add(node)

    for node in by_id:
        visit(node)
    return errors


def cmd_validate() -> int:
    plan1_doc = load_yaml(PLAN1)
    plan15_doc = load_yaml(PLAN15)
    plan1 = plan1_doc.get("tasks", [])
    plan15 = plan15_doc.get("tasks", [])

    errors = validate_plan(plan1, PLAN1_REQUIRED, "PLAN-1")
    errors += validate_plan(plan15, PLAN15_REQUIRED, "PLAN-1.5")

    if plan1_doc.get("active_plan") != "PLAN-1":
        errors.append("TASKS.yaml: active_plan must be PLAN-1")
    if any(task.get("plan") != "PLAN-1" for task in plan1):
        errors.append("TASKS.yaml: must contain PLAN-1 tasks only")

    # The two plans stay in separate files until a human merges them.
    if plan15 and plan15_doc.get("plan") != "PLAN-1.5":
        errors.append("TASKS-1.5.yaml: plan must be PLAN-1.5")
    if any(str(task.get("id", "")).startswith("P15-") for task in plan1):
        errors.append("TASKS.yaml: PLAN-1.5 tasks must not be merged in")
    if any(str(task.get("id", "")).startswith("P1-") and not str(task.get("id", "")).startswith("P15-")
           for task in plan15):
        errors.append("TASKS-1.5.yaml: PLAN-1 tasks must not be merged in")

    if errors:
        print("INVALID TASK GRAPH")
        for error in errors:
            print("-", error)
        return 1

    print(f"OK: {len(plan1)} PLAN-1 tasks, {len(plan15)} PLAN-1.5 tasks, dependencies valid, no cycles")
    return 0


COMMANDS = {"next": cmd_next, "status": cmd_status, "validate": cmd_validate}

if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "next"
    if command not in COMMANDS:
        sys.exit(f"unknown command {command!r}; expected one of {', '.join(COMMANDS)}")
    raise SystemExit(COMMANDS[command]())
