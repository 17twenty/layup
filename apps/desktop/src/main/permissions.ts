import type { Logger } from './logging';

/**
 * Screen-capture permission onboarding.
 *
 * Permission is an OS decision Layup cannot make for the user, so the product's
 * job is to state clearly what is missing and take them to the right place.
 * Guessing "it will probably work" produces a black screen share, which is the
 * worst possible first impression.
 */
export type PermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'not-required'
  | 'unknown';

export interface CapturePermission {
  status: PermissionStatus;
  /** Whether capture can be attempted at all right now. */
  canCapture: boolean;
  /** What the person needs to do, in plain words. Empty when granted. */
  guidance: string;
  /** Whether this platform can deep-link to the relevant settings page. */
  canOpenSettings: boolean;
  platform: NodeJS.Platform;
}

/** The slice of Electron's systemPreferences this needs. */
export interface SystemPreferencesLike {
  getMediaAccessStatus(mediaType: 'screen' | 'camera' | 'microphone'): string;
}

export interface PermissionServiceOptions {
  systemPreferences?: SystemPreferencesLike;
  platform?: NodeJS.Platform;
  openExternal: (url: string) => Promise<void>;
  log: Logger;
}

/** macOS deep link to Privacy & Security -> Screen Recording. */
export const MACOS_SCREEN_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export interface PermissionService {
  capture(): CapturePermission;
  /** Opens the OS settings page for screen recording. */
  openCaptureSettings(): Promise<boolean>;
}

export function createPermissionService(options: PermissionServiceOptions): PermissionService {
  const platform = options.platform ?? process.platform;

  function status(): PermissionStatus {
    // Only macOS gates screen capture behind a system permission. Windows and
    // Linux ask at capture time or not at all.
    if (platform !== 'darwin') return 'not-required';
    if (!options.systemPreferences) return 'unknown';
    const raw = options.systemPreferences.getMediaAccessStatus('screen');
    switch (raw) {
      case 'granted':
      case 'denied':
      case 'restricted':
      case 'not-determined':
        return raw;
      default:
        return 'unknown';
    }
  }

  return {
    capture() {
      const current = status();
      const canOpenSettings = platform === 'darwin';
      const guidance = {
        granted: '',
        'not-required': '',
        denied:
          'macOS is blocking screen recording for Layup. Open Privacy & Security → Screen Recording, tick Layup, then restart it.',
        restricted:
          'Screen recording is restricted on this Mac by policy. An administrator has to allow it.',
        'not-determined':
          'macOS has not been asked yet. Start a share and approve the Screen Recording prompt, then restart Layup.',
        unknown: 'Screen-recording permission could not be checked on this machine.',
      }[current];

      return {
        status: current,
        canCapture: current === 'granted' || current === 'not-required' || current === 'unknown',
        guidance,
        canOpenSettings,
        platform,
      };
    },

    async openCaptureSettings() {
      if (platform !== 'darwin') return false;
      await options.openExternal(MACOS_SCREEN_SETTINGS_URL);
      options.log.info('opened screen-recording settings', { platform });
      return true;
    },
  };
}
