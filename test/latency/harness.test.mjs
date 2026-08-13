import assert from 'node:assert/strict';
import test from 'node:test';

import { PERCENTILES, RESULT_SCHEMA_VERSION, createRun, percentile, summarise } from './harness.mjs';
import { scenario as synthetic } from './scenarios/synthetic.mjs';

test('nearest-rank percentiles return observed samples', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 50), 5);
  assert.equal(percentile(sorted, 95), 10);
  assert.equal(percentile(sorted, 100), 10);
  assert.equal(percentile([], 50), null);
});

test('summary reports count, extremes, mean and every percentile slot', () => {
  const summary = summarise([5, 1, 3]);
  assert.equal(summary.count, 3);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 5);
  assert.equal(summary.mean, 3);
  for (const p of PERCENTILES) {
    assert.ok(`p${p}` in summary.percentiles, `missing p${p}`);
  }
});

test('a run produces a complete, machine-readable result document', () => {
  let now = 1000;
  const run = createRun({
    scenario: 'unit-test',
    unit: 'ms',
    budgets: { p95: 10 },
    context: { route: 'loopback' },
    clock: () => now,
  });

  const mark = run.begin('span');
  now += 4;
  assert.equal(run.end(mark), 4);
  run.record(6);
  assert.equal(run.sampleCount, 2);

  const result = run.finish({ notes: 'unit test' });

  assert.equal(result.schemaVersion, RESULT_SCHEMA_VERSION);
  assert.equal(result.scenario, 'unit-test');
  assert.equal(result.unit, 'ms');
  assert.equal(result.samples.count, 2);
  assert.equal(result.samples.percentiles.p95, 6);
  assert.deepEqual(result.budgets, [{ metric: 'p95', limit: 10, actual: 6, withinBudget: true }]);
  assert.equal(result.withinBudget, true);
  assert.equal(result.context.route, 'loopback');
  assert.ok(Date.parse(result.startedAt) > 0 && Date.parse(result.endedAt) > 0);

  for (const key of ['platform', 'arch', 'cpuModel', 'cpuCount', 'totalMemoryMb', 'nodeVersion']) {
    assert.ok(result.environment[key] !== undefined, `environment.${key} missing`);
  }
  assert.ok(Number.isFinite(result.harness.overheadPerSampleNs));
  assert.equal(result.harness.notes, 'unit test');
});

test('a breached budget is reported, not hidden', () => {
  const run = createRun({ scenario: 'over-budget', budgets: { p50: 1 }, clock: () => 0 });
  run.record(50);
  const result = run.finish();
  assert.equal(result.withinBudget, false);
  assert.deepEqual(result.budgets[0], { metric: 'p50', limit: 1, actual: 50, withinBudget: false });
});

test('a run refuses a non-numeric sample', () => {
  const run = createRun({ scenario: 'guard', clock: () => 0 });
  assert.throws(() => run.record(Number.NaN), /finite number/);
  assert.throws(() => run.end('missing'), /no open mark/);
});

test('the synthetic scenario generates deterministic results', async () => {
  const first = await synthetic.run({ samples: 200, seed: 7 });
  const second = await synthetic.run({ samples: 200, seed: 7 });
  assert.deepEqual(first.samples, second.samples);
  assert.equal(first.samples.count, 200);
  assert.equal(first.withinBudget, true);
});
