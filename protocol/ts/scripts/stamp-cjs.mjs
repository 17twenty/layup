// The package is ESM by default; this marks the CommonJS output so Node (and
// the Electron main process) can `require` the binding.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

writeFileSync(
  fileURLToPath(new URL('../dist/cjs/package.json', import.meta.url)),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
);
