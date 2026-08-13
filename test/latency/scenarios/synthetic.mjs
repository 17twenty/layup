/**
 * Synthetic scenario: proves the harness produces a valid result document
 * before any real media exists. Deterministic given a seed, so a regression in
 * the harness itself is visible.
 */
import { createRun } from '../harness.mjs';

/** Small deterministic PRNG (mulberry32). */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const scenario = {
  id: 'synthetic-latency',
  description: 'Deterministic samples that exercise the result schema end to end.',
  budgets: { p50: 40, p95: 90 },

  async run({ samples = 500, seed = 20260813 } = {}) {
    const random = seeded(seed);
    const run = createRun({
      scenario: scenario.id,
      unit: 'ms',
      budgets: scenario.budgets,
      context: { generator: 'mulberry32', seed, requestedSamples: samples },
    });

    for (let i = 0; i < samples; i += 1) {
      // A plausible interaction-latency shape: a floor plus an occasional tail.
      const base = 18 + random() * 14;
      const tail = random() < 0.05 ? 25 + random() * 40 : 0;
      run.record(base + tail);
    }

    return run.finish({ notes: 'synthetic samples; no real media involved' });
  },
};
