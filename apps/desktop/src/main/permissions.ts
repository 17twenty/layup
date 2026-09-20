import type { HelperState } from './helper-supervisor';
import type { Logger } from './logging';

/**
 * Permission onboarding for everything a call needs.
 *
 * Permission is an OS decision Layup cannot make for the user, so the product's
 * job is to state clearly what is missing and take them to the right place.
 * Guessing "it will probably work" produces a black screen share, a silent
 * microphone, or - worst of all - remote control that appears to be on and
 * quietly discards every click.
 *
 * Two of the four can be asked for from inside the app, and two cannot:
 *
 *   - **Camera** and **microphone** have a real in-process prompt
 *     (`askForMediaAccess`), and macOS shows it exactly once. After a refusal
 *     it answers false without showing anything, so the offer is withdrawn
 *     rather than left as a button that does nothing.
 *   - **Screen Recording** and **Accessibility** have no prompt at all. They
 *     are granted in System Settings and need the app restarted afterwards, so
 *     the only honest affordance is a deep link to the exact pane.
 */
export type PermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'not-required'
  | 'unknown';

/** Everything a first call needs, in the order somebody meets it. */
export const PERMISSION_KINDS = ['camera', 'microphone', 'screen', 'accessibility'] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export interface PermissionState {
  status: PermissionStatus;
  /** Whether the thing this permission gates will actually work right now. */
  ok: boolean;
  /** What the person needs to do, in plain words. Empty when nothing is. */
  guidance: string;
  /** Whether this platform can deep-link to the relevant settings page. */
  canOpenSettings: boolean;
  /** Whether the real OS prompt can still be raised from inside Layup. */
  canRequest: boolean;
}

export type PermissionsState = Record<PermissionKind, PermissionState>;

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
  /** macOS only, and only for the two that have a prompt at all. */
  askForMediaAccess?(mediaType: 'camera' | 'microphone'): Promise<boolean>;
}

export interface PermissionServiceOptions {
  systemPreferences?: SystemPreferencesLike;
  platform?: NodeJS.Platform;
  openExternal: (url: string) => Promise<void>;
  /**
   * The input helper's latest report.
   *
   * Accessibility is read from here and nowhere else: `AXIsProcessTrusted` is
   * answered per process, and the helper is the process that would actually
   * post the event. `systemPreferences` cannot answer this question, and a
   * service that invented an answer would be inventing exactly the one whose
   * absence fails silently.
   */
  helperState?: () => HelperState | undefined;
  log: Logger;
}

/** macOS deep link to Privacy & Security -> Camera. */
export const MACOS_CAMERA_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera';

/** macOS deep link to Privacy & Security -> Microphone. */
export const MACOS_MICROPHONE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

/** macOS deep link to Privacy & Security -> Screen Recording. */
export const MACOS_SCREEN_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** macOS deep link to Privacy & Security -> Accessibility. */
export const MACOS_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

/** Which pane each permission is granted in. */
export const MACOS_SETTINGS_URLS: Record<PermissionKind, string> = {
  camera: MACOS_CAMERA_SETTINGS_URL,
  microphone: MACOS_MICROPHONE_SETTINGS_URL,
  screen: MACOS_SCREEN_SETTINGS_URL,
  accessibility: MACOS_ACCESSIBILITY_SETTINGS_URL,
};

/**
 * What to say, per permission, per state.
 *
 * Every sentence names Layup, because these are read in System Settings next
 * to a list of other applications, and "the app" is not a row anybody can find.
 */
const GUIDANCE: Record<PermissionKind, Record<PermissionStatus, string>> = {
  camera: {
    granted: '',
    'not-required': '',
    denied:
      'macOS is blocking the camera for Layup. Open Privacy & Security → Camera and tick Layup.',
    restricted:
      'The camera is restricted on this Mac by policy. An administrator has to allow Layup to use it.',
    'not-determined':
      'Layup has not asked for the camera yet. Allow it now and your face is ready before the call, not during it.',
    unknown:
      'Camera permission could not be checked on this machine, so Layup cannot say whether your face will appear.',
  },
  microphone: {
    granted: '',
    'not-required': '',
    denied:
      'macOS is blocking the microphone for Layup. Open Privacy & Security → Microphone and tick Layup.',
    restricted:
      'The microphone is restricted on this Mac by policy. An administrator has to allow Layup to use it.',
    'not-determined':
      'Layup has not asked for the microphone yet. Allow it now and your voice is ready before the call, not during it.',
    unknown:
      'Microphone permission could not be checked on this machine, so Layup cannot say whether you will be heard.',
  },
  screen: {
    granted: '',
    'not-required': '',
    denied:
      'macOS is blocking screen recording for Layup. Open Privacy & Security → Screen Recording, tick Layup, then restart it.',
    restricted:
      'Screen recording is restricted on this Mac by policy. An administrator has to allow Layup to record the screen.',
    'not-determined':
      'macOS has not been asked yet. Start a share and approve the Screen Recording prompt, then restart Layup.',
    unknown:
      'Screen-recording permission could not be checked on this machine, so Layup cannot say whether a share will work.',
  },
  accessibility: {
    granted: '',
    'not-required': '',
    denied:
      'macOS is not letting Layup control this Mac, so remote control does nothing at all - the ' +
      'other person clicks and types and it never arrives, silently. Open Privacy & Security → ' +
      'Accessibility, tick Layup, then restart it.',
    restricted:
      'Controlling this Mac is restricted by policy. An administrator has to allow Layup in Accessibility.',
    'not-determined':
      'macOS has not been asked yet. Open Privacy & Security → Accessibility, tick Layup, then restart it.',
    unknown:
      "Layup's input helper has not reported yet, so Accessibility could not be checked. Remote control stays off until it does.",
  },
};

export interface PermissionService {
  capture(): CapturePermission;
  /** Opens the OS settings page for screen recording. */
  openCaptureSettings(): Promise<boolean>;
  /** Every permission a call needs, all four at once. */
  all(): PermissionsState;
  /**
   * Raises the real OS prompt, where macOS has one. Answers whether the
   * permission is granted now - screen recording and accessibility have no
   * prompt and always answer false.
   */
  request(kind: PermissionKind): Promise<boolean>;
  /** Opens the exact settings pane this permission is granted in. */
  openSettings(kind: PermissionKind): Promise<boolean>;
}

export function createPermissionService(options: PermissionServiceOptions): PermissionService {
  const platform = options.platform ?? process.platform;
  const onMac = platform === 'darwin';

  async function openSettings(kind: PermissionKind): Promise<boolean> {
    if (!onMac) return false;
    await options.openExternal(MACOS_SETTINGS_URLS[kind]);
    options.log.info('opened settings', { kind, platform });
    return true;
  }

  /** Normalises whatever Electron hands back into our own vocabulary. */
  function mediaStatus(mediaType: 'screen' | 'camera' | 'microphone'): PermissionStatus {
    // Only macOS gates these behind a system permission. Windows and Linux ask
    // at capture time or not at all.
    if (!onMac) return 'not-required';
    if (!options.systemPreferences) return 'unknown';
    const raw = options.systemPreferences.getMediaAccessStatus(mediaType);
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

  /**
   * Accessibility, from the helper's own `AXIsProcessTrusted` answer.
   *
   * A helper that has not reported is `unknown`, never `denied`: "we have not
   * heard yet" and "macOS said no" are different things, and only one of them
   * is worth interrupting somebody about.
   */
  function accessibilityStatus(): PermissionStatus {
    if (!onMac) return 'not-required';
    const capabilities = options.helperState?.()?.capabilities;
    if (!capabilities) return 'unknown';
    return capabilities.pointerMove && capabilities.keyboard ? 'granted' : 'denied';
  }

  function statusOf(kind: PermissionKind): PermissionStatus {
    return kind === 'accessibility' ? accessibilityStatus() : mediaStatus(kind);
  }

  function stateOf(kind: PermissionKind): PermissionState {
    const status = statusOf(kind);
    return {
      status,
      // Unknown must never block: a status we could not read is not a refusal,
      // and stopping somebody over it would be worse than letting them try.
      ok: status === 'granted' || status === 'not-required' || status === 'unknown',
      guidance: GUIDANCE[kind][status],
      canOpenSettings: onMac,
      // macOS shows the media prompt exactly once. After that `askForMediaAccess`
      // answers false without showing anything, so offering it again would be a
      // button that does nothing.
      canRequest:
        onMac && (kind === 'camera' || kind === 'microphone') && status === 'not-determined',
    };
  }

  return {
    capture() {
      const current = mediaStatus('screen');
      return {
        status: current,
        canCapture: current === 'granted' || current === 'not-required' || current === 'unknown',
        guidance: GUIDANCE.screen[current],
        canOpenSettings: onMac,
        platform,
      };
    },

    openCaptureSettings: () => openSettings('screen'),

    all() {
      return {
        camera: stateOf('camera'),
        microphone: stateOf('microphone'),
        screen: stateOf('screen'),
        accessibility: stateOf('accessibility'),
      };
    },

    async request(kind) {
      // Nothing to ask for: these are not gated off macOS.
      if (!onMac) return true;
      if (kind !== 'camera' && kind !== 'microphone') {
        // Said plainly rather than faked. macOS grants these two only from
        // System Settings, and only takes effect after a restart.
        options.log.info('permission cannot be requested in process', { kind });
        return false;
      }
      const granted = (await options.systemPreferences?.askForMediaAccess?.(kind)) ?? false;
      options.log.info('asked macOS for media access', { kind, granted });
      return granted;
    },

    openSettings,
  };
}
