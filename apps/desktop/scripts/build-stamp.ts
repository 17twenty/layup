import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The build stamp, for whichever build tool asks for it.
 *
 * Vite is the only part of this build that can put a constant inside a bundle,
 * so `git rev-parse` runs here. A tree with no git — a source tarball, a
 * sandboxed CI step — is not an error: it builds, and it says `dev`.
 */

/** No node globals are assumed: the web tsconfig does not load them. */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

function shortCommit(): string {
  const override = env?.LAYUP_COMMIT;
  if (override) return override;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}

function version(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
    return String((JSON.parse(raw) as { version?: string }).version ?? '');
  } catch {
    return '';
  }
}

/** `define` entries for a Vite config. JSON, so they land as string literals. */
export function buildStampDefines(): Record<string, string> {
  return {
    __LAYUP_VERSION__: JSON.stringify(version()),
    __LAYUP_COMMIT__: JSON.stringify(shortCommit()),
    __LAYUP_BUILT_AT__: JSON.stringify(
      env?.LAYUP_BUILT_AT || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ),
  };
}
