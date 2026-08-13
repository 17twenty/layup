# Benchmarks

Latency is a product feature (SPEC.md §2.5), so it is measured from Stage 0 and
every claim in `PLAN-1-REVIEW.md` must point at a result file here.

## Running

```bash
make bench                              # every scenario, writes results
node test/latency/run.mjs --list        # available scenarios
node test/latency/run.mjs synthetic-latency --samples 2000
node test/latency/run.mjs --no-write    # print JSON, write nothing
make test-bench                         # harness unit tests
```

The runner exits non-zero when a scenario breaches its declared budget, so a
performance regression fails a build instead of becoming a footnote.

## Result schema (`schemaVersion: 1`)

```jsonc
{
  "schemaVersion": 1,
  "scenario": "loopback-rtt",
  "unit": "ms",
  "startedAt": "2026-08-13T11:29:25.343Z",
  "endedAt":   "2026-08-13T11:29:25.700Z",
  "wallClockMs": 356.9,
  "samples": {
    "count": 200,
    "min": 1.35, "max": 3.1, "mean": 1.56,
    "percentiles": { "p50": 1.507, "p75": 1.6, "p90": 1.68, "p95": 1.729, "p99": 2.4 }
  },
  "budgets": [{ "metric": "p95", "limit": 25, "actual": 1.729, "withinBudget": true }],
  "withinBudget": true,
  "context":     { "transport": "http/1.1 loopback", "requestedSamples": 200 },
  "environment": { "platform": "darwin", "arch": "arm64", "cpuModel": "...", "cpuCount": 12,
                   "totalMemoryMb": 65536, "nodeVersion": "v26.5.0", "gitCommit": "8a74511" },
  "harness":     { "overheadPerSampleNs": 12, "notes": "..." }
}
```

Percentiles are **nearest-rank**, so `p95` is an observed sample rather than an
interpolated value. `results/<scenario>/<timestamp>.json` files are committed:
they are the evidence trail.

## Harness overhead

Every result carries `harness.overheadPerSampleNs`, measured during that run.
It is the cost of recording one sample (tens of nanoseconds on a modern
machine), i.e. four to five orders of magnitude below the millisecond-scale
latencies PLAN-1 argues about. Subtract it only if a scenario records more than
~10⁵ samples; otherwise it is noise.

Scenarios that use `begin()`/`end()` measure the span with `process.hrtime`, so
the harness cost that *is* inside the measurement is one clock read per side.

## Adding a scenario

1. Create `test/latency/scenarios/<id>.mjs` exporting
   `scenario = { id, description, budgets, async run(options) }`.
2. Build the result with `createRun()` from `../harness.mjs` so the schema and
   the environment metadata stay identical across scenarios.
3. Register it in `test/latency/run.mjs`.
4. Declare budgets from SPEC.md §16 where one applies.

## Current scenarios

| id | What it measures | Budgets |
|---|---|---|
| `synthetic-latency` | Deterministic samples that prove the harness and schema work before real media exists. | p50 < 40ms, p95 < 90ms |
| `loopback-rtt` | HTTP request/response round trip on loopback: the floor under every later network number. | p95 < 25ms |
