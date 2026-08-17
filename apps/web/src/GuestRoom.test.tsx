import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuestRoom } from './GuestRoom';
import type { GuestRoomState } from './useGuestRoom';
import type { Layup } from '@core/control-client';

const layup: Layup = {
  id: 'lay_1',
  organisationId: 'org_1',
  title: 'Thursday sync',
  visibility: 'LINK',
  active: true,
  createdAt: '2026-08-17T09:00:00Z',
  hasCreatorAuthority: true,
  participants: [],
};

function room(overrides: Partial<GuestRoomState> = {}): GuestRoomState {
  return {
    layup,
    remotes: [],
    av: { cameraEnabled: true, microphoneEnabled: true, muted: false },
    connection: 'connected',
    setCamera: vi.fn(),
    setMicrophone: vi.fn(),
    sampleCursors: () => [],
    identify: () => ({ colour: '#000', label: 'S' }),
    moveCursor: vi.fn(),
    ...overrides,
  };
}

function fakeStream(): MediaStream {
  return { id: 'screen', getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
}

describe('the call, in a browser', () => {
  it('says so plainly when nobody is sharing - a call is still a call', () => {
    render(<GuestRoom room={room()} />);
    expect(screen.getByTestId('no-screen').textContent).toMatch(/nobody is sharing/i);
  });

  it('shows the shared screen when one arrives', () => {
    render(<GuestRoom room={room({ screen: fakeStream(), presenterMembershipId: 'mem_host' })} />);
    expect(screen.getByTestId('shared-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('no-screen')).toBeNull();
  });

  it('toggles the camera and the microphone', async () => {
    const state = room();
    render(<GuestRoom room={state} />);

    await userEvent.click(screen.getByRole('button', { name: /camera/i }));
    expect(state.setCamera).toHaveBeenCalledWith(false);

    await userEvent.click(screen.getByRole('button', { name: /mute|microphone/i }));
    expect(state.setMicrophone).toHaveBeenCalledWith(false);
  });

  it('reports the pointer against the surface it is over, in that surface’s own pixels', () => {
    const state = room({ screen: fakeStream(), presenterMembershipId: 'mem_host' });
    render(<GuestRoom room={state} />);

    const surface = screen.getByTestId('screen-surface');
    // jsdom gives every element a zero-sized box, so the size is stated here
    // the way a real layout would report it.
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1200, width: 1920, height: 1200,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerMove(surface, { clientX: 480, clientY: 300 });

    // Pixels plus the surface size; normalising to 0..1 is the sender's job,
    // and the one place it is done for every client (protocol/cursor.ts).
    expect(state.moveCursor).toHaveBeenCalledWith({ x: 480, y: 300, width: 1920, height: 1200 });
  });

  it('does not report the pointer when there is no shared surface to be over', () => {
    const state = room();
    render(<GuestRoom room={state} />);
    expect(screen.queryByTestId('screen-surface')).toBeNull();
    expect(state.moveCursor).not.toHaveBeenCalled();
  });

  it('offers nothing that would share this guest’s own screen', () => {
    render(<GuestRoom room={room()} />);
    expect(screen.queryByRole('button', { name: /share/i })).toBeNull();
  });
});
