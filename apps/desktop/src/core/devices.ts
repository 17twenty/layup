/**
 * The microphones, cameras and speakers this machine has.
 *
 * Listing devices is separate from using them on purpose: `enumerateDevices`
 * is a browser API with two awkward properties, and both belong in one place.
 *
 *   - Until capture permission has been granted, Chromium returns the right
 *     *number* of devices with blank labels. A list of blanks is worse than no
 *     list, so {@link DeviceList.labelsHidden} says so and the UI offers a way
 *     to grant access instead of a row of empty rectangles.
 *   - `setSinkId` - choosing which speaker a media element plays out of - is
 *     not universally available. Where it is missing, output stays on the
 *     system default rather than throwing mid-call.
 *
 * Nothing here touches a peer connection. Changing a device is
 * `RTCRtpSender.replaceTrack` and never a renegotiation (see `av.ts`).
 */

/** One device, as it is offered to a person. */
export interface DeviceInfo {
  deviceId: string;
  /** Empty until capture permission has been granted - see `labelsHidden`. */
  label: string;
}

export interface DeviceList {
  microphones: DeviceInfo[];
  cameras: DeviceInfo[];
  speakers: DeviceInfo[];
  /**
   * True when devices exist but not one of them has a name, which is what
   * "permission has not been granted yet" looks like from here.
   */
  labelsHidden: boolean;
}

export const NO_DEVICES: DeviceList = {
  microphones: [],
  cameras: [],
  speakers: [],
  labelsHidden: false,
};

type Enumerate = () => Promise<MediaDeviceInfo[]>;

/** What this machine has, grouped by kind. Never rejects: a call carrying on
 *  with the devices it already has beats an exception. */
export async function listDevices(enumerate?: Enumerate): Promise<DeviceList> {
  const read =
    enumerate ??
    (() =>
      typeof navigator === 'undefined'
        ? Promise.resolve([])
        : navigator.mediaDevices.enumerateDevices());

  let devices: MediaDeviceInfo[];
  try {
    devices = await read();
  } catch {
    return NO_DEVICES;
  }

  // A device with no id cannot be selected, so it is not on the list.
  const usable = devices.filter((device) => Boolean(device.deviceId));
  const of = (kind: MediaDeviceKind): DeviceInfo[] =>
    usable
      .filter((device) => device.kind === kind)
      .map((device) => ({ deviceId: device.deviceId, label: device.label ?? '' }));

  return {
    microphones: of('audioinput'),
    cameras: of('videoinput'),
    speakers: of('audiooutput'),
    labelsHidden: usable.length > 0 && usable.every((device) => !device.label),
  };
}

/** Whether a chosen device is still plugged in. No choice means the system
 *  default, which is always there. */
export function includesDevice(devices: DeviceInfo[], deviceId: string | undefined): boolean {
  if (!deviceId) return true;
  return devices.some((device) => device.deviceId === deviceId);
}

interface SinkCapable {
  setSinkId?: (deviceId: string) => Promise<void>;
}

/** Whether this build can choose an output device at all. */
export function supportsSpeakerChoice(element?: HTMLMediaElement | null): boolean {
  return typeof (element as SinkCapable | null | undefined)?.setSinkId === 'function';
}

/**
 * Plays this element out of the chosen speaker, where the platform allows it.
 *
 * Returns whether it took. A speaker that refuses is a preference that did not
 * apply, not a broken call, so nothing here throws.
 */
export async function applySpeaker(
  element: HTMLMediaElement | null | undefined,
  deviceId: string | undefined,
): Promise<boolean> {
  const sink = (element as SinkCapable | null | undefined)?.setSinkId;
  if (!element || !deviceId || typeof sink !== 'function') return false;
  try {
    await sink.call(element, deviceId);
    return true;
  } catch {
    return false;
  }
}
