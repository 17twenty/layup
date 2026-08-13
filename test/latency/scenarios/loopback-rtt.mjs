/**
 * Loopback round-trip scenario: measures the cost of a request/response hop on
 * this machine. It is the floor under every later network measurement - if the
 * loopback RTT is already 5ms, no ICE route will look good.
 */
import { createServer } from 'node:http';
import { createRun } from '../harness.mjs';

export const scenario = {
  id: 'loopback-rtt',
  description: 'HTTP request/response round trip over loopback.',
  budgets: { p95: 25 },

  async run({ samples = 200 } = {}) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const run = createRun({
      scenario: scenario.id,
      unit: 'ms',
      budgets: scenario.budgets,
      context: { transport: 'http/1.1 loopback', requestedSamples: samples },
    });

    try {
      // Warm up so the first-connection cost does not pollute the percentiles.
      for (let i = 0; i < 10; i += 1) await fetch(`http://127.0.0.1:${port}/`);

      for (let i = 0; i < samples; i += 1) {
        const mark = run.begin(`req-${i}`);
        const response = await fetch(`http://127.0.0.1:${port}/`);
        await response.arrayBuffer();
        run.end(mark);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    return run.finish({ notes: 'loopback only; no Layup component in the path yet' });
  },
};
