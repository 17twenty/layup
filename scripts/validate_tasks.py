#!/usr/bin/env python3
from pathlib import Path
import sys, yaml

root = Path(__file__).resolve().parents[1]
data = yaml.safe_load((root / "TASKS.yaml").read_text())
tasks = data.get("tasks", [])
errors=[]
ids=[t.get('id') for t in tasks]
if len(ids) != len(set(ids)):
    errors.append('duplicate task IDs')
by_id={t.get('id'):t for t in tasks}
required=['id','plan','phase','title','status','goal','user_visible_behaviour','depends_on','allowed_paths','non_goals','forbidden','protocol_changes','security','acceptance','performance','observability','definition_of_done']
for i,t in enumerate(tasks):
    for k in required:
        if k not in t: errors.append(f"{t.get('id',i)} missing {k}")
    if t.get('status') not in {'todo','in_progress','done','blocked'}:
        errors.append(f"{t.get('id')} invalid status")
    for d in t.get('depends_on',[]):
        if d not in by_id: errors.append(f"{t.get('id')} unknown dependency {d}")
# cycle check
visiting=set(); visited=set()
def visit(n):
    if n in visited: return
    if n in visiting:
        errors.append(f'cycle involving {n}'); return
    visiting.add(n)
    for d in by_id[n].get('depends_on',[]): visit(d)
    visiting.remove(n); visited.add(n)
for n in by_id: visit(n)
if data.get('active_plan') != 'PLAN-1': errors.append('seed active_plan must be PLAN-1')
if any(t.get('plan') != 'PLAN-1' for t in tasks): errors.append('TASKS.yaml must contain PLAN-1 tasks only in seed')
if errors:
    print('INVALID TASK GRAPH')
    for e in errors: print('-',e)
    sys.exit(1)
print(f"OK: {len(tasks)} PLAN-1 tasks, dependencies valid, no cycles")
