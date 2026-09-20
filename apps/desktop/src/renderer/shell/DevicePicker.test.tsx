import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DevicePicker } from './DevicePicker';

const microphones = [
  { deviceId: 'default', label: 'Default - MacBook Microphone' },
  { deviceId: 'mic_usb', label: 'Yeti Stereo Microphone' },
];
const speakers = [{ deviceId: 'spk_1', label: 'MacBook Speakers' }];

function picker(overrides: Partial<Parameters<typeof DevicePicker>[0]> = {}) {
  const onSelectMicrophone = vi.fn();
  const onSelectSpeaker = vi.fn();
  render(
    <DevicePicker
      label="Choose microphone and speaker"
      testId="choose-microphone"
      labelsHidden={false}
      choices={[
        { title: 'Microphone', devices: microphones, onSelect: onSelectMicrophone },
        { title: 'Speaker', devices: speakers, onSelect: onSelectSpeaker },
      ]}
      {...overrides}
    />,
  );
  return { onSelectMicrophone, onSelectSpeaker };
}

describe('choosing a device from the call bar', () => {
  it('opens a list from the caret, with the speaker alongside the microphone', async () => {
    picker();
    expect(screen.queryByTestId('choose-microphone-menu')).toBeNull();

    await userEvent.click(screen.getByTestId('choose-microphone'));

    expect(screen.getByTestId('choose-microphone-menu')).toBeTruthy();
    expect(screen.getByText('Microphone')).toBeTruthy();
    expect(screen.getByText('Speaker')).toBeTruthy();
    expect(screen.getByText('Yeti Stereo Microphone')).toBeTruthy();
    expect(screen.getByText('MacBook Speakers')).toBeTruthy();
  });

  it('ticks the one in use', async () => {
    picker({
      choices: [
        {
          title: 'Microphone',
          devices: microphones,
          selectedId: 'mic_usb',
          onSelect: vi.fn(),
        },
      ],
    });
    await userEvent.click(screen.getByTestId('choose-microphone'));

    expect(screen.getByTestId('device-mic_usb').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('device-default').getAttribute('aria-checked')).toBe('false');
  });

  it('ticks the first device when nothing has been chosen - that is the default', async () => {
    picker();
    await userEvent.click(screen.getByTestId('choose-microphone'));

    expect(screen.getByTestId('device-default').getAttribute('aria-checked')).toBe('true');
  });

  it('reports the chosen device and shuts', async () => {
    const h = picker();
    await userEvent.click(screen.getByTestId('choose-microphone'));
    await userEvent.click(screen.getByTestId('device-mic_usb'));

    expect(h.onSelectMicrophone).toHaveBeenCalledWith('mic_usb');
    expect(h.onSelectSpeaker).not.toHaveBeenCalled();
    expect(screen.queryByTestId('choose-microphone-menu')).toBeNull();
  });

  it('chooses a speaker from the same list', async () => {
    const h = picker();
    await userEvent.click(screen.getByTestId('choose-microphone'));
    await userEvent.click(screen.getByTestId('device-spk_1'));

    expect(h.onSelectSpeaker).toHaveBeenCalledWith('spk_1');
  });

  it('re-reads the devices when the list is opened', async () => {
    const onOpen = vi.fn();
    picker({ onOpen });

    await userEvent.click(screen.getByTestId('choose-microphone'));
    expect(onOpen).toHaveBeenCalledTimes(1);

    // Shutting it again is not a reason to enumerate.
    await userEvent.click(screen.getByTestId('choose-microphone'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shuts on a click outside it', async () => {
    picker();
    await userEvent.click(screen.getByTestId('choose-microphone'));
    await userEvent.click(screen.getByTestId('choose-microphone-scrim'));

    expect(screen.queryByTestId('choose-microphone-menu')).toBeNull();
  });

  it('asks for permission instead of listing blanks', async () => {
    // enumerateDevices returns the right number of devices with empty labels
    // until capture permission is granted. Rows of nothing look broken.
    picker({
      labelsHidden: true,
      choices: [
        { title: 'Microphone', devices: [{ deviceId: 'a1b2', label: '' }], onSelect: vi.fn() },
      ],
    });
    await userEvent.click(screen.getByTestId('choose-microphone'));

    expect(screen.getByTestId('device-labels-hint').textContent).toMatch(/grant access/i);
    expect(screen.queryByTestId('device-a1b2')).toBeNull();
  });

  it('says so when there is nothing of that kind at all', async () => {
    picker({
      choices: [{ title: 'Camera', devices: [], onSelect: vi.fn() }],
    });
    await userEvent.click(screen.getByTestId('choose-microphone'));

    expect(screen.getByText(/No camera found/i)).toBeTruthy();
  });
});
