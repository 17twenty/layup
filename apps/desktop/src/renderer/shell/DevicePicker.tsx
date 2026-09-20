import { useCallback, useState } from 'react';
import type { DeviceInfo } from '../../core/devices';

/**
 * The caret beside the microphone and camera buttons: which device, mid-call.
 *
 * It is a caret on an existing button rather than a settings screen, because
 * the moment somebody needs this is the moment they have just been told they
 * cannot be heard - and that is not a moment to go looking for preferences.
 *
 * Choosing here never renegotiates the call: the selection ends up at
 * `RTCRtpSender.replaceTrack` (see `core/av.ts`). Nothing on screen remounts,
 * so the people in the call carry on talking through the change.
 *
 * Until capture permission has been granted the browser hands back devices
 * with blank labels. A list of blank rows is worse than no list, so this shows
 * one honest line instead.
 */
export interface DeviceChoice {
  /** "Microphone", "Speaker", "Camera" - the heading over its devices. */
  title: string;
  devices: DeviceInfo[];
  /** The chosen device; undefined means whatever the system defaults to. */
  selectedId?: string;
  onSelect: (deviceId: string) => void;
}

export interface DevicePickerProps {
  /** What the caret opens, said in full for screen readers. */
  label: string;
  /** Stable handle for tests: `choose-microphone`, `choose-camera`. */
  testId: string;
  choices: DeviceChoice[];
  /** True when devices exist but not one of them has a name. */
  labelsHidden: boolean;
  /** Opening the list is when it is worth re-reading the devices. */
  onOpen?: () => void;
}

export function DevicePicker({ label, testId, choices, labelsHidden, onOpen }: DevicePickerProps) {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      if (!wasOpen) onOpen?.();
      return !wasOpen;
    });
  }, [onOpen]);

  return (
    <div className="callbar__picker">
      <button
        type="button"
        className="callbar__caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-testid={testId}
        onClick={toggle}
      >
        <CaretIcon />
      </button>

      {open ? (
        <div
          className="device-menu-scrim"
          data-testid={`${testId}-scrim`}
          onClick={() => setOpen(false)}
          onContextMenu={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <div
            className="device-menu"
            role="menu"
            aria-label={label}
            data-testid={`${testId}-menu`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          >
            {labelsHidden ? (
              // Task 9 owns the permission itself; this is only about not
              // showing somebody four identical empty rectangles.
              <p className="device-menu__hint" data-testid="device-labels-hint">
                Grant access to see device names. Allow Layup your microphone and camera in System
                Settings, then open this again.
              </p>
            ) : (
              choices.map((choice) => (
                <section key={choice.title} className="device-menu__group">
                  <h3 className="device-menu__title">{choice.title}</h3>
                  {choice.devices.length === 0 ? (
                    <p className="device-menu__hint">No {choice.title.toLowerCase()} found.</p>
                  ) : (
                    choice.devices.map((device, index) => {
                      const chosen = isChosen(device, choice.selectedId, index);
                      return (
                        <button
                          key={device.deviceId}
                          type="button"
                          role="menuitemradio"
                          aria-checked={chosen}
                          className="device-menu__item"
                          data-testid={`device-${device.deviceId}`}
                          onClick={() => {
                            choice.onSelect(device.deviceId);
                            setOpen(false);
                          }}
                        >
                          <span className="device-menu__tick" aria-hidden="true">
                            {chosen ? '✓' : ''}
                          </span>
                          <span>{device.label || 'Unnamed device'}</span>
                        </button>
                      );
                    })
                  )}
                </section>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Nothing chosen means the system default, which is the first device the
 *  browser lists - so that is the one wearing the tick. */
function isChosen(device: DeviceInfo, selectedId: string | undefined, index: number): boolean {
  return selectedId ? device.deviceId === selectedId : index === 0;
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
