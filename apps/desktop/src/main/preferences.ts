import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Small preferences that exist whether or not a server has been added.
 *
 * Deliberately a file of its own rather than a field on `DesktopConfig`
 * (config.ts): the config only exists once somebody has joined a server, and
 * `soundsMuted` needs a home before that - and needs to survive `server:forget`,
 * which clears the config outright.
 *
 * A corrupt or missing file is treated as the defaults, the same "never fatal"
 * rule config.ts uses: the worst outcome of a bad byte here is a sound nobody
 * asked to mute, not an app that will not start.
 */
export interface DesktopPreferences {
  /** Notification sounds (the arrival knock) are silenced when true. */
  soundsMuted: boolean;
}

export const DEFAULT_PREFERENCES: DesktopPreferences = { soundsMuted: false };

export interface PreferencesStore {
  read(): DesktopPreferences;
  write(next: DesktopPreferences): void;
}

function isPreferences(value: unknown): value is DesktopPreferences {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.soundsMuted === 'boolean';
}

export function createPreferencesStore(options: { path: string }): PreferencesStore {
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(options.path, 'utf8'));
        return isPreferences(parsed) ? parsed : DEFAULT_PREFERENCES;
      } catch {
        return DEFAULT_PREFERENCES;
      }
    },
    write(next) {
      mkdirSync(dirname(options.path), { recursive: true });
      writeFileSync(options.path, JSON.stringify(next, null, 2));
    },
  };
}
