/**
 * Lets a plain `node --test` file import the desktop's TypeScript sources.
 *
 * Node strips types on its own; what it will not do is guess. Two small gaps
 * are filled here and nothing else:
 *
 *   - `@layup/protocol` resolves to the built CommonJS binding, whose named
 *     exports Node can see through;
 *   - a relative import with no extension - the desktop's sources are written
 *     for a bundler, so `./data-channels`, not `./data-channels.ts` - is
 *     retried with `.ts`, and told it is an ES module so Node does not have to
 *     guess that from the file's contents.
 *
 * It exists so an end-to-end test can drive the **real** modules rather than a
 * reimplementation of them. A test that reimplements what it is testing proves
 * only that the test agrees with itself.
 */
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const protocolCjs = pathToFileURL(join(repoRoot, 'protocol', 'ts', 'dist', 'cjs', 'index.js')).href;

let installed = false;

/** Installs the hooks. Safe to call more than once. */
export function installTsHook() {
  if (installed) return;
  installed = true;

  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@layup/protocol') return next(protocolCjs, context);

      try {
        return withTypeScriptFormat(next(specifier, context));
      } catch (error) {
        if (!specifier.startsWith('.')) throw error;
        return withTypeScriptFormat(next(`${specifier}.ts`, context));
      }
    },
  });
}

function withTypeScriptFormat(resolution) {
  if (!resolution?.url?.endsWith('.ts')) return resolution;
  // Saying so up front avoids Node parsing the file as CommonJS first and
  // warning when that fails.
  return { ...resolution, format: 'module-typescript' };
}
