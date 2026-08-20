import { describe, expect, it, vi } from 'vitest';
import {
  MACOS_ACCESSIBILITY_SETTINGS_URL,
  MACOS_CAMERA_SETTINGS_URL,
  MACOS_MICROPHONE_SETTINGS_URL,
  MACOS_SCREEN_SETTINGS_URL,
  PERMISSION_KINDS,
  createPermissionService,
} from './permissions';
import type { HelperState } from './helper-supervisor';
import { createLogger } from './logging';

function service(platform: NodeJS.Platform, screenStatus?: string) {
  const openExternal = vi.fn(async () => undefined);
  const svc = createPermissionService({
    platform,
    ...(screenStatus === undefined
      ? {}
      : { systemPreferences: { getMediaAccessStatus: () => screenStatus } }),
    openExternal,
    log: createLogger({ level: 'error', write: () => {} }),
  });
  return { svc, openExternal };
}

describe('capture permission onboarding', () => {
  it('reports granted macOS permission as ready', () => {
    const { svc } = service('darwin', 'granted');
    expect(svc.capture()).toMatchObject({ status: 'granted', canCapture: true, guidance: '' });
  });

  it('explains a denied permission and offers the settings page', async () => {
    const { svc, openExternal } = service('darwin', 'denied');
    const permission = svc.capture();

    expect(permission).toMatchObject({ status: 'denied', canCapture: false, canOpenSettings: true });
    expect(permission.guidance).toMatch(/Privacy & Security.*Screen Recording/);
    expect(permission.guidance).toMatch(/restart/i);

    expect(await svc.openCaptureSettings()).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(MACOS_SCREEN_SETTINGS_URL);
  });

  it('distinguishes not-determined from denied', () => {
    const { svc } = service('darwin', 'not-determined');
    const permission = svc.capture();
    expect(permission.status).toBe('not-determined');
    expect(permission.canCapture).toBe(false);
    expect(permission.guidance).toMatch(/has not been asked yet/);
  });

  it('names a policy restriction as an administrator problem', () => {
    const { svc } = service('darwin', 'restricted');
    expect(svc.capture().guidance).toMatch(/administrator/);
  });

  it('does not invent a permission gate on Windows or Linux', async () => {
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      const { svc, openExternal } = service(platform);
      expect(svc.capture()).toMatchObject({
        status: 'not-required',
        canCapture: true,
        canOpenSettings: false,
        guidance: '',
      });
      expect(await svc.openCaptureSettings()).toBe(false);
      expect(openExternal).not.toHaveBeenCalled();
    }
  });

  it('stays usable when the status cannot be read', () => {
    const { svc } = service('darwin', 'something-new');
    const permission = svc.capture();
    // Unknown must not block the person from trying.
    expect(permission).toMatchObject({ status: 'unknown', canCapture: true });
    expect(permission.guidance).toMatch(/could not be checked/);
  });
});

/**
 * The other three (task 9).
 *
 * Camera and microphone have a real in-process prompt; Screen Recording and
 * Accessibility do not, and the only honest thing to do about them is to say
 * so and open the right pane. Accessibility is the one that fails silently, so
 * its answer comes from the process that would actually post the event.
 */
function all(options: {
  platform?: NodeJS.Platform;
  camera?: string;
  microphone?: string;
  screen?: string;
  helper?: HelperState;
  ask?: (mediaType: 'camera' | 'microphone') => Promise<boolean>;
} = {}) {
  const openExternal = vi.fn(async () => undefined);
  const askForMediaAccess = vi.fn(options.ask ?? (async () => true));
  const svc = createPermissionService({
    platform: options.platform ?? 'darwin',
    systemPreferences: {
      getMediaAccessStatus: (mediaType) =>
        ({
          camera: options.camera ?? 'granted',
          microphone: options.microphone ?? 'granted',
          screen: options.screen ?? 'granted',
        })[mediaType],
      askForMediaAccess,
    },
    ...(options.helper ? { helperState: () => options.helper as HelperState } : {}),
    openExternal,
    log: createLogger({ level: 'error', write: () => {} }),
  });
  return { svc, openExternal, askForMediaAccess };
}

/** A helper that has connected and reported what macOS lets it do. */
function helperSaying(trusted: boolean): HelperState {
  return {
    running: true,
    restarts: 0,
    capabilities: {
      platform: 'darwin',
      pointerMove: trusted,
      pointerButton: trusted,
      pointerWheel: trusted,
      keyboard: trusted,
    },
  };
}

describe('every permission a call needs', () => {
  it('reports all four, each in plain words that name Layup', () => {
    const { svc } = all({
      camera: 'denied',
      microphone: 'not-determined',
      screen: 'denied',
      helper: helperSaying(false),
    });
    const state = svc.all();

    expect(Object.keys(state).sort()).toEqual([
      'accessibility',
      'camera',
      'microphone',
      'screen',
    ]);
    for (const kind of PERMISSION_KINDS) {
      expect(state[kind].ok).toBe(false);
      // Not a status code shown to a person: a sentence, about this product.
      expect(state[kind].guidance).toMatch(/Layup/);
      expect(state[kind].canOpenSettings).toBe(true);
    }
  });

  it('says nothing needs doing when everything is granted', () => {
    const { svc } = all({ helper: helperSaying(true) });
    const state = svc.all();
    for (const kind of PERMISSION_KINDS) {
      expect(state[kind]).toMatchObject({ status: 'granted', ok: true, guidance: '' });
    }
  });

  it('asks macOS for the camera and the microphone in process, which is a real prompt', async () => {
    const { svc, askForMediaAccess, openExternal } = all({
      camera: 'not-determined',
      microphone: 'not-determined',
      helper: helperSaying(true),
    });

    expect(svc.all().camera.canRequest).toBe(true);
    expect(svc.all().microphone.canRequest).toBe(true);

    expect(await svc.request('camera')).toBe(true);
    expect(await svc.request('microphone')).toBe(true);
    expect(askForMediaAccess).toHaveBeenCalledWith('camera');
    expect(askForMediaAccess).toHaveBeenCalledWith('microphone');
    // The prompt is the point: nobody is sent to System Settings for these.
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('carries a refusal back rather than claiming the prompt worked', async () => {
    const { svc } = all({ camera: 'not-determined', ask: async () => false });
    expect(await svc.request('camera')).toBe(false);
  });

  it('stops offering a prompt macOS will not show twice', () => {
    // Once denied, askForMediaAccess returns false without showing anything.
    // Offering "Allow" again would be a button that does nothing.
    const { svc } = all({ camera: 'denied' });
    expect(svc.all().camera).toMatchObject({ canRequest: false, canOpenSettings: true });
  });

  it('refuses to pretend screen recording or accessibility can be prompted', async () => {
    const { svc, askForMediaAccess } = all({ screen: 'denied', helper: helperSaying(false) });

    expect(svc.all().screen.canRequest).toBe(false);
    expect(svc.all().accessibility.canRequest).toBe(false);
    expect(await svc.request('screen')).toBe(false);
    expect(await svc.request('accessibility')).toBe(false);
    expect(askForMediaAccess).not.toHaveBeenCalled();
  });

  it('deep-links to the exact settings pane for each one', async () => {
    expect(MACOS_CAMERA_SETTINGS_URL).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    );
    expect(MACOS_MICROPHONE_SETTINGS_URL).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
    expect(MACOS_SCREEN_SETTINGS_URL).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    expect(MACOS_ACCESSIBILITY_SETTINGS_URL).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );

    const { svc, openExternal } = all();
    for (const [kind, url] of [
      ['camera', MACOS_CAMERA_SETTINGS_URL],
      ['microphone', MACOS_MICROPHONE_SETTINGS_URL],
      ['screen', MACOS_SCREEN_SETTINGS_URL],
      ['accessibility', MACOS_ACCESSIBILITY_SETTINGS_URL],
    ] as const) {
      expect(await svc.openSettings(kind)).toBe(true);
      expect(openExternal).toHaveBeenLastCalledWith(url);
    }
  });
});

describe('accessibility, as the helper reports it', () => {
  it('is granted when the helper says macOS trusts it', () => {
    const { svc } = all({ helper: helperSaying(true) });
    expect(svc.all().accessibility).toMatchObject({ status: 'granted', ok: true, guidance: '' });
  });

  it('is denied when the helper says AXIsProcessTrusted is false', () => {
    const { svc } = all({ helper: helperSaying(false) });
    const accessibility = svc.all().accessibility;

    expect(accessibility.status).toBe('denied');
    expect(accessibility.ok).toBe(false);
    expect(accessibility.guidance).toMatch(/Privacy & Security.*Accessibility/);
    expect(accessibility.guidance).toMatch(/Layup/);
    // The whole point: this is the failure nobody can see happening.
    expect(accessibility.guidance).toMatch(/silent|nothing|never arrive/i);
    expect(accessibility.guidance).toMatch(/restart/i);
  });

  it('never guesses from systemPreferences, because the helper posts the event', () => {
    // systemPreferences knows nothing about Accessibility, and a service that
    // invented an answer here would be inventing the one that fails quietly.
    const { svc } = all({ helper: undefined });
    expect(svc.all().accessibility.status).toBe('unknown');
  });

  it('does not call a helper that has not reported yet denied', () => {
    const { svc } = all({ helper: { running: false, restarts: 0 } });
    const accessibility = svc.all().accessibility;
    expect(accessibility.status).toBe('unknown');
    // Unknown must not block, exactly as it does not for screen recording.
    expect(accessibility.ok).toBe(true);
    expect(accessibility.guidance).toMatch(/Layup/);
  });
});

describe('permissions off macOS', () => {
  it('reports not-required rather than pretending', async () => {
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      const { svc, openExternal, askForMediaAccess } = all({
        platform,
        camera: 'denied',
        microphone: 'denied',
        screen: 'denied',
        helper: helperSaying(false),
      });
      const state = svc.all();

      for (const kind of PERMISSION_KINDS) {
        expect(state[kind]).toMatchObject({
          status: 'not-required',
          ok: true,
          guidance: '',
          canOpenSettings: false,
          canRequest: false,
        });
        expect(await svc.openSettings(kind)).toBe(false);
      }
      expect(openExternal).not.toHaveBeenCalled();
      expect(askForMediaAccess).not.toHaveBeenCalled();
    }
  });
});
