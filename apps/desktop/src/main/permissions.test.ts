import { describe, expect, it, vi } from 'vitest';
import { MACOS_SCREEN_SETTINGS_URL, createPermissionService } from './permissions';
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
