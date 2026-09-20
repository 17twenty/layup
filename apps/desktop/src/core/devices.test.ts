import { describe, expect, it, vi } from 'vitest';
import { includesDevice, listDevices, applySpeaker, NO_DEVICES } from './devices';

function enumerating(devices: Array<Partial<MediaDeviceInfo>>) {
  return async () => devices as MediaDeviceInfo[];
}

describe('the devices on this machine', () => {
  it('groups them by kind, with their labels', async () => {
    const devices = await listDevices(
      enumerating([
        { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Microphone' },
        { deviceId: 'mic_usb', kind: 'audioinput', label: 'Yeti Stereo Microphone' },
        { deviceId: 'cam_1', kind: 'videoinput', label: 'FaceTime HD Camera' },
        { deviceId: 'spk_1', kind: 'audiooutput', label: 'MacBook Speakers' },
      ]),
    );

    expect(devices.microphones).toEqual([
      { deviceId: 'default', label: 'Default - MacBook Microphone' },
      { deviceId: 'mic_usb', label: 'Yeti Stereo Microphone' },
    ]);
    expect(devices.cameras).toEqual([{ deviceId: 'cam_1', label: 'FaceTime HD Camera' }]);
    expect(devices.speakers).toEqual([{ deviceId: 'spk_1', label: 'MacBook Speakers' }]);
    expect(devices.labelsHidden).toBe(false);
  });

  it('says the labels are hidden when permission has not been granted', async () => {
    // Chromium hands back the right *number* of devices with blank labels
    // until capture permission has been granted, so a list would be blanks.
    const devices = await listDevices(
      enumerating([
        { deviceId: 'a1b2', kind: 'audioinput', label: '' },
        { deviceId: 'c3d4', kind: 'videoinput', label: '' },
      ]),
    );

    expect(devices.labelsHidden).toBe(true);
    expect(devices.microphones).toHaveLength(1);
  });

  it('is not "hidden" merely because one device has no name', async () => {
    const devices = await listDevices(
      enumerating([
        { deviceId: 'a1b2', kind: 'audioinput', label: 'Yeti Stereo Microphone' },
        { deviceId: 'c3d4', kind: 'videoinput', label: '' },
      ]),
    );

    expect(devices.labelsHidden).toBe(false);
  });

  it('has nothing to hide when there are no devices at all', async () => {
    const devices = await listDevices(enumerating([]));
    expect(devices).toEqual(NO_DEVICES);
  });

  it('survives enumerateDevices failing outright', async () => {
    const devices = await listDevices(async () => {
      throw new Error('not supported');
    });
    expect(devices).toEqual(NO_DEVICES);
  });

  it('ignores devices with no id, which are no use to switch to', async () => {
    const devices = await listDevices(
      enumerating([
        { deviceId: '', kind: 'audioinput', label: 'Phantom' },
        { deviceId: 'mic_1', kind: 'audioinput', label: 'Real' },
      ]),
    );
    expect(devices.microphones).toEqual([{ deviceId: 'mic_1', label: 'Real' }]);
  });
});

describe('whether a chosen device is still there', () => {
  const microphones = [
    { deviceId: 'mic_1', label: 'One' },
    { deviceId: 'mic_2', label: 'Two' },
  ];

  it('finds one that is', () => {
    expect(includesDevice(microphones, 'mic_2')).toBe(true);
  });

  it('does not find one that has been unplugged', () => {
    expect(includesDevice(microphones, 'mic_gone')).toBe(false);
  });

  it('treats "no choice" as always present - that is the default device', () => {
    expect(includesDevice(microphones, undefined)).toBe(true);
  });
});

describe('choosing a speaker', () => {
  it('routes the element at the chosen output', async () => {
    const setSinkId = vi.fn(async () => {});
    const element = { setSinkId } as unknown as HTMLMediaElement;

    await expect(applySpeaker(element, 'spk_1')).resolves.toBe(true);
    expect(setSinkId).toHaveBeenCalledWith('spk_1');
  });

  it('does nothing where setSinkId does not exist', async () => {
    // Not universally available: it must degrade to the system default rather
    // than throw in the middle of a call.
    const element = {} as HTMLMediaElement;
    await expect(applySpeaker(element, 'spk_1')).resolves.toBe(false);
  });

  it('does nothing without an element or a choice', async () => {
    await expect(applySpeaker(null, 'spk_1')).resolves.toBe(false);
    await expect(applySpeaker({ setSinkId: vi.fn() } as unknown as HTMLMediaElement, undefined)).resolves.toBe(
      false,
    );
  });

  it('swallows a refusal - a speaker that will not take is not a broken call', async () => {
    const element = {
      setSinkId: vi.fn(async () => {
        throw new Error('NotAllowedError');
      }),
    } as unknown as HTMLMediaElement;

    await expect(applySpeaker(element, 'spk_1')).resolves.toBe(false);
  });
});
