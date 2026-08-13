import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapturePicker } from './CapturePicker';
import type { CaptureSourcesResponse } from '../../shared/ipc';

const sources: CaptureSourcesResponse = {
  sources: [
    { id: 'screen:1:0', name: 'Entire Screen', kind: 'screen', thumbnailDataUrl: 'data:image/png;base64,AA' },
    { id: 'window:9:0', name: 'Editor', kind: 'window' },
  ],
};

function stubCapture(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(window, 'layup', {
    value: { protocolVersion: 1, capture: { sources: vi.fn(async () => sources) } },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(getUserMedia) },
    configurable: true,
  });
  return navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
}

function fakeStream() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop, kind: 'video' }] } as unknown as MediaStream;
  return { stream, stop };
}

describe('capture picker', () => {
  it('lists screens and windows with previews', async () => {
    stubCapture(async () => fakeStream().stream);
    render(<CapturePicker />);

    await waitFor(() => expect(screen.getByTestId('source-screen:1:0')).toBeTruthy());
    expect(screen.getByText('Entire Screen')).toBeTruthy();
    expect(screen.getByText('Editor')).toBeTruthy();
    // Decorative thumbnail: alt="" keeps it out of the accessibility tree.
    expect(screen.getByTestId('source-screen:1:0').querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,AA',
    );
  });

  it('asks Chromium for the chosen source by id', async () => {
    const media = fakeStream();
    const getUserMedia = stubCapture(async () => media.stream);
    render(<CapturePicker />);
    await waitFor(() => expect(screen.getByTestId('source-screen:1:0')).toBeTruthy());

    await userEvent.click(screen.getByTestId('source-screen:1:0'));

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:1:0', maxFrameRate: 30 },
      },
    });
    await waitFor(() => expect(screen.getByTestId('capture-preview')).toBeTruthy());
  });

  it('stops every track when the preview is stopped', async () => {
    const media = fakeStream();
    stubCapture(async () => media.stream);
    render(<CapturePicker />);
    await waitFor(() => expect(screen.getByTestId('source-screen:1:0')).toBeTruthy());

    await userEvent.click(screen.getByTestId('source-screen:1:0'));
    await waitFor(() => expect(screen.getByTestId('capture-preview')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: 'Stop preview' }));
    expect(media.stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('capture-preview')).toBeNull());
  });

  it('releases capture when the picker unmounts', async () => {
    const media = fakeStream();
    stubCapture(async () => media.stream);
    const view = render(<CapturePicker />);
    await waitFor(() => expect(screen.getByTestId('source-screen:1:0')).toBeTruthy());
    await userEvent.click(screen.getByTestId('source-screen:1:0'));
    await waitFor(() => expect(screen.getByTestId('capture-preview')).toBeTruthy());

    view.unmount();
    expect(media.stop).toHaveBeenCalled();
  });

  it('explains a refused capture instead of showing a blank frame', async () => {
    stubCapture(async () => {
      throw new Error('NotAllowedError: Permission denied');
    });
    render(<CapturePicker />);
    await waitFor(() => expect(screen.getByTestId('source-screen:1:0')).toBeTruthy());

    await userEvent.click(screen.getByTestId('source-screen:1:0'));
    await waitFor(() => expect(screen.getByText(/Permission denied/)).toBeTruthy());
    expect(screen.queryByTestId('capture-preview')).toBeNull();
  });
});
