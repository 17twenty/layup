#!/usr/bin/env python3
from pathlib import Path
import sys, yaml

root = Path(__file__).resolve().parents[1]
data = yaml.safe_load((root / "TASKS.yaml").read_text())
tasks = data["tasks"]
by_id = {t["id"]: t for t in tasks}

for t in tasks:
    if t.get("plan") != data.get("active_plan") or t.get("status") != "todo":
        continue
    if all(by_id[d]["status"] == "done" for d in t.get("depends_on", [])):
        print(f"{t['id']} | phase {t['phase']} | {t['title']}")
        print(t['goal'])
        sys.exit(0)

unfinished = [t for t in tasks if t.get("plan") == data.get("active_plan") and t.get("status") != "done"]
if unfinished:
    print("No eligible task. Unfinished tasks are blocked or depend on unfinished work.")
    for t in unfinished[:10]:
        print(f"- {t['id']}: {t['status']} deps={t.get('depends_on', [])}")
    sys.exit(2)
print("All tasks in active plan are done. PLAN-1 human gate is next.")
