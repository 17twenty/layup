import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { AvState } from '../../core/av';
import { FaceTiles } from './FaceTiles';

/**
 * The remote tiles are where the other person's voice is, so "which speaker?"
 * is answered here - with `setSinkId` on the element that is already playing,
 * never by replacing it. The last time media elements were replaced mid-call,
 * the audio went with them.
 */
const local: AvState = { cameraEnabled: true, microphoneEnabled: true, muted: false };
const karl = {
  membershipId: 'm-karl',
  displayName: 'Karl',
  camera: {} as MediaStream,
  connection: { connected: true },
} as never;

const handlers = { onToggleCamera: vi.fn(), onToggleMicrophone: vi.fn() };
let setSinkId: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setSinkId = vi.fn(async () => {});
  Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
    configurable: true,
    writable: true,
    value: setSinkId,
  });
});

afterEach(() => {
  delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
});

describe('faces and the speaker they play out of', () => {
  it('routes the other person at the chosen speaker', async () => {
    render(<FaceTiles local={local} remotes={[karl]} speakerId="spk_1" {...handlers} />);

    await waitFor(() => expect(setSinkId).toHaveBeenCalledWith('spk_1'));
    // Your own tile is muted, so there is nothing to route there.
    expect(setSinkId).toHaveBeenCalledTimes(1);
  });

  it('leaves output alone when no speaker has been chosen', async () => {
    render(<FaceTiles local={local} remotes={[karl]} {...handlers} />);

    await waitFor(() => expect(screen.getByTestId('face-m-karl')).toBeInTheDocument());
    expect(setSinkId).not.toHaveBeenCalled();
  });

  it('changes speaker without replacing the video element', async () => {
    const view = render(<FaceTiles local={local} remotes={[karl]} speakerId="spk_1" {...handlers} />);
    const before = screen.getByTestId('face-m-karl').querySelector('video');

    view.rerender(<FaceTiles local={local} remotes={[karl]} speakerId="spk_2" {...handlers} />);

    await waitFor(() => expect(setSinkId).toHaveBeenLastCalledWith('spk_2'));
    // The very same element: a remount here is a dropped call.
    expect(screen.getByTestId('face-m-karl').querySelector('video')).toBe(before);
  });

  it('survives a platform with no setSinkId at all', async () => {
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;

    render(<FaceTiles local={local} remotes={[karl]} speakerId="spk_1" {...handlers} />);

    // Output stays on the system default rather than throwing mid-call.
    await waitFor(() => expect(screen.getByTestId('face-m-karl')).toBeInTheDocument());
  });
});
