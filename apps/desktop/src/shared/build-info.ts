/**
 * Which build this is.
 *
 * Two people testing together need one string they can read back to us —
 * `v0.2.0 (abc1234)` — so a bug report names the bits it happened on. The one
 * thing this must never do is say `undefined`, because that reads like an
 * answer and is not one. Anything missing becomes `dev`, which is true.
 *
 * The stamps arrive two ways. Vite replaces the identifiers below in the
 * bundles it builds (renderer, preload). The main process is compiled by tsc,
 * which has no such mechanism, so it resolves its own stamp from the metadata
 * electron-builder writes at package time (see main/index.ts).
 */

export interface BuildInfo {
  /** The application version, from package.json. */
  version: string;
  /** The short commit this was built from, or `dev`. */
  commit: string;
  /** When it was built, ISO-8601, or `dev`. */
  builtAt: string;
}

/** What every stamp falls back to. Short, honest, and not a version number. */
export const UNSTAMPED = 'dev';

/** Replaced by Vite `define`; absent everywhere else, hence the typeof guards. */
declare const __LAYUP_VERSION__: string;
declare const __LAYUP_COMMIT__: string;
declare const __LAYUP_BUILT_AT__: string;

/**
 * A stamp is only a stamp if it is a non-empty string that is not a stringified
 * absence. `String(undefined)` is how `undefined` reaches a screen, so the two
 * words that produce it are refused by name.
 */
function stamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') return undefined;
  return trimmed;
}

/**
 * Turns whatever the build did or did not inject into a complete BuildInfo.
 *
 * Pure, so the fallbacks are testable without a build.
 */
export function resolveBuildInfo(raw: {
  version?: unknown;
  commit?: unknown;
  builtAt?: unknown;
}): BuildInfo {
  return {
    // A version still has to look like a version, so this fallback is not `dev`.
    version: stamp(raw.version) ?? '0.0.0-dev',
    commit: stamp(raw.commit) ?? UNSTAMPED,
    builtAt: stamp(raw.builtAt) ?? UNSTAMPED,
  };
}

/** The environment, when there is one. The renderer has no `process` at all. */
const environment = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;

/** This build, as the bundle it is running in knows it. */
export const BUILD_INFO: BuildInfo = resolveBuildInfo({
  version: typeof __LAYUP_VERSION__ === 'string' ? __LAYUP_VERSION__ : environment?.LAYUP_VERSION,
  commit: typeof __LAYUP_COMMIT__ === 'string' ? __LAYUP_COMMIT__ : environment?.LAYUP_COMMIT,
  builtAt:
    typeof __LAYUP_BUILT_AT__ === 'string' ? __LAYUP_BUILT_AT__ : environment?.LAYUP_BUILT_AT,
});
