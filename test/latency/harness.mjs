/**
 * Benchmark harness for Layup.
 *
 * Every latency-sensitive claim in PLAN-1 has to be backed by a repeatable,
 * machine-readable measurement. This module owns the result schema so that
 * results from different scenarios (input RTT, glass-to-glass, cursor rate)
 * stay comparable over time.
 *
 * Dependency-free on purpose: benchmarks must run on a bare machine.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

/** Bump when the shape of a result file changes incompatibly. */
export const RESULT_SCHEMA_VERSION = 1;

/** Percentiles every scenario reports, so results are directly comparable. */
export const PERCENTILES = [50, 75, 90, 95, 99];

/**
 * Nearest-rank percentile over an already-sorted ascending array.
 * Nearest-rank (not interpolation) keeps p95 an observed sample, which is what
 * we want when arguing about real interaction latency.
 */
export function percentile(sortedSamples, p) {
  if (sortedSamples.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedSamples.length);
  const index = Math.min(sortedSamples.length - 1, Math.max(0, rank - 1));
  return sortedSamples[index];
}

export function summarise(samples) {
  if (samples.length === 0) {
    return { count: 0, min: null, max: null, mean: null, percentiles: {} };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const percentiles = {};
  for (const p of PERCENTILES) {
    percentiles[`p${p}`] = round(percentile(sorted, p));
  }
  return {
    count: sorted.length,
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
    percentiles,
  };
}

function round(value) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

/** Environment metadata, so a result can be interpreted a month later. */
export function environmentMetadata() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    nodeVersion: process.version,
    gitCommit: gitCommit(),
  };
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * A single benchmark run.
 *
 * @param {object} options
 * @param {string} options.scenario   stable scenario id, e.g. "input-rtt-loopback"
 * @param {string} [options.unit]     unit of the recorded samples (default "ms")
 * @param {object} [options.budgets]  e.g. {p50: 80, p95: 150} - breaching one fails the run
 * @param {object} [options.context]  free-form scenario metadata (route, resolution, ...)
 * @param {() => number} [options.clock] monotonic clock in ms
 */
export function createRun(options) {
  const clock = options.clock ?? (() => Number(process.hrtime.bigint()) / 1e6);
  const scenario = options.scenario;
  if (!scenario) throw new Error('a benchmark run needs a scenario id');

  const samples = [];
  const marks = new Map();
  const startedAtMs = Date.now();
  const startedAtClock = clock();

  return {
    scenario,

    /** Record one observation. */
    record(value) {
      if (!Number.isFinite(value)) throw new Error(`sample must be a finite number, got ${value}`);
      samples.push(value);
    },

    /** Start a timed span; returns the mark id. */
    begin(id = String(marks.size)) {
      marks.set(id, clock());
      return id;
    },

    /** End a timed span and record its duration. */
    end(id) {
      const startedAt = marks.get(id);
      if (startedAt === undefined) throw new Error(`no open mark ${id}`);
      marks.delete(id);
      const duration = clock() - startedAt;
      samples.push(duration);
      return duration;
    },

    get sampleCount() {
      return samples.length;
    },

    /** Close the run and produce the result document. */
    finish(extra = {}) {
      const durationMs = clock() - startedAtClock;
      const summary = summarise(samples);
      const budgets = options.budgets ?? {};
      const budgetResults = Object.entries(budgets).map(([key, limit]) => {
        const actual = key in summary.percentiles ? summary.percentiles[key] : summary[key] ?? null;
        return { metric: key, limit, actual, withinBudget: actual !== null && actual <= limit };
      });

      return {
        schemaVersion: RESULT_SCHEMA_VERSION,
        scenario,
        unit: options.unit ?? 'ms',
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(startedAtMs + durationMs).toISOString(),
        wallClockMs: round(durationMs),
        samples: summary,
        budgets: budgetResults,
        withinBudget: budgetResults.every((result) => result.withinBudget),
        context: { ...(options.context ?? {}), ...(extra.context ?? {}) },
        environment: environmentMetadata(),
        harness: {
          // Measured per run so later measurements can subtract our own cost.
          overheadPerSampleNs: measureOverheadNs(),
          notes: extra.notes ?? null,
        },
      };
    },
  };
}

/** Cost of one record() call, so scenario numbers can be interpreted honestly. */
export function measureOverheadNs(iterations = 20000) {
  const scratch = [];
  const startedAt = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    scratch.push(i);
  }
  const elapsed = Number(process.hrtime.bigint() - startedAt);
  return Math.round(elapsed / iterations);
}
