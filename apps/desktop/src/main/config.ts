import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The first thing this application has ever persisted.
 *
 * It holds a bearer token, so it is written 0600 and never logged. A corrupt
 * file is treated as "no server yet" rather than as a fatal error: the worst
 * outcome of a bad byte should be re-adding a server, not an app that will not
 * start.
 */
export interface DesktopConfig {
  serverUrl: string;
  token: string;
  userId: string;
  displayName: string;
}

export interface ConfigStore {
  read(): DesktopConfig | undefined;
  write(next: DesktopConfig): void;
  clear(): void;
}

function isConfig(value: unknown): value is DesktopConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.serverUrl === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.userId === 'string' &&
    typeof candidate.displayName === 'string' &&
    candidate.serverUrl !== '' &&
    candidate.token !== ''
  );
}

export function createConfigStore(options: { path: string }): ConfigStore {
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(options.path, 'utf8'));
        return isConfig(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    write(next) {
      mkdirSync(dirname(options.path), { recursive: true });
      writeFileSync(options.path, JSON.stringify(next, null, 2), { mode: 0o600 });
    },
    clear() {
      rmSync(options.path, { force: true });
    },
  };
}
