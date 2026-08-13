#!/usr/bin/env node
/**
 * Benchmark runner.
 *
 *   node test/latency/run.mjs                     # every scenario
 *   node test/latency/run.mjs synthetic-latency   # one scenario
 *   node test/latency/run.mjs --samples 1000      # override sample count
 *   node test/latency/run.mjs --no-write          # print only
 *
 * Results are written to benchmarks/results/<scenario>/<timestamp>.json and are
 * the evidence artefact for any latency claim in PLAN-1.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { scenario as synthetic } from './scenarios/synthetic.mjs';
import { scenario as loopbackRtt } from './scenarios/loopback-rtt.mjs';

const SCENARIOS = [synthetic, loopbackRtt];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resultsRoot = join(repoRoot, 'benchmarks', 'results');

function parseArgs(argv) {
  const options = { ids: [], write: true, samples: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-write') options.write = false;
    else if (arg === '--samples') options.samples = Number(argv[++i]);
    else if (arg === '--list') options.list = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else options.ids.push(arg);
  }
  return options;
}

function summaryLine(result) {
  const { p50, p95 } = result.samples.percentiles;
  const budget = result.budgets.length === 0 ? '' : result.withinBudget ? ' [within budget]' : ' [OVER BUDGET]';
  return `${result.scenario}: n=${result.samples.count} p50=${p50}${result.unit} p95=${p95}${result.unit}${budget}`;
}

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  for (const scenario of SCENARIOS) console.log(`${scenario.id} - ${scenario.description}`);
  process.exit(0);
}

const selected = options.ids.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => options.ids.includes(s.id));
if (selected.length === 0) {
  console.error(`no scenario matched ${options.ids.join(', ')}`);
  process.exit(2);
}

let overBudget = false;
for (const scenario of selected) {
  const result = await scenario.run(options.samples ? { samples: options.samples } : {});
  console.log(summaryLine(result));

  if (options.write) {
    const dir = join(resultsRoot, result.scenario);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${result.startedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`  -> ${file.slice(repoRoot.length + 1)}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  if (!result.withinBudget) overBudget = true;
}

// A breached budget is a task failure, not a note in a log.
process.exit(overBudget ? 1 : 0);
