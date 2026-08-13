# Status

Active plan: PLAN-1
PLAN-2: LOCKED
PLAN-1 gate: IN PROGRESS

## Current state

- next task: P1-0102
- completed: 9
- blocked: 0
- repository implementation: bootstrapped (npm workspaces + go.work)

## Last run

- task: P1-0101 domain IDs and core types
- result: done
- tests: `go test ./internal/domain/...` ok (8 cases), `make fmt-check`, `make test-go` green
- evidence:
  - `test/latency/harness.mjs` - result schema v1: scenario, unit, startedAt/endedAt,
    wallClockMs, samples{count,min,max,mean,percentiles p50/p75/p90/p95/p99}, budgets with
    pass/fail, context, environment (platform/arch/cpu/memory/node/gitCommit), harness overhead
  - nearest-rank percentiles so p95 is an observed sample, not an interpolation
  - `test/latency/run.mjs` - CLI (`--list`, `--samples`, `--no-write`), writes
    `benchmarks/results/<scenario>/<timestamp>.json`, exits non-zero on a breached budget
  - synthetic proof: `synthetic-latency` (deterministic, seeded) n=500 p50=25.413ms
    p95=31.843ms within budget; `loopback-rtt` n=200 p50=1.507ms p95=1.729ms
  - `make test-bench` (6 node:test cases) covers percentile maths, full document shape,
    budget breach reporting and determinism
  - harness overhead is recorded per run (`harness.overheadPerSampleNs`) and documented in
    `benchmarks/README.md`

## Recent runs

- P1-0005 done - structured logging baseline
- P1-0006 done - CI build and test matrix
- P1-0007 done - desktop-to-control smoke path
- P1-0008 done - latency benchmark harness skeleton
- P1-0101 done - domain IDs and core types

## Known issues / decisions needed

- Deviation from the seed's suggested `allowed_paths`: npm workspaces are used instead of pnpm
  (pnpm is not installed on the build host and no global installs were made). This adds
  `package-lock.json` instead of `pnpm-lock.yaml`. Everything else in the task is unchanged.
- `scripts/next_task.py` / `scripts/validate_tasks.py` need PyYAML; the host python3 is externally
  managed, so they are run from a virtualenv.
- Redaction key lists are duplicated in Go and TypeScript (no shared artefact is allowed by
  P1-0005's `allowed_paths`); each side has its own test, so drift is visible but not blocked.
- PLAN-2 remains a hypothesis document until the PLAN-1 human gate.
