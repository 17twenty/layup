import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AvState } from '../../core/av';
import { CompactBar } from './CompactBar';

const av: AvState = { cameraEnabled: true, microphoneEnabled: true, muted: false };

const karl = {
  membershipId: 'm-karl',
  displayName: 'Karl',
  camera: {} as MediaStream,
  connection: { connected: true },
} as never;

function renderPill(overrides: Partial<Parameters<typeof CompactBar>[0]> = {}) {
  const handlers = {
    onToggleCamera: vi.fn(),
    onToggleMicrophone: vi.fn(),
    onShare: vi.fn(),
    onStopSharing: vi.fn(),
    onLeave: vi.fn(),
  };
  render(
    <CompactBar local={av} remotes={[karl]} selfName="Nick" presenting={false} {...handlers} {...overrides} />,
  );
  return handlers;
}

describe('the pill', () => {
  it('holds the people and your own controls, and nothing else', () => {
    renderPill();

    expect(screen.getByTestId('face-m-karl')).toBeInTheDocument();
    // Microphone, camera, share, leave - in that order, under the faces.
    expect(screen.getByTestId('toggle-microphone')).toBeInTheDocument();
    expect(screen.getByTestId('toggle-camera')).toBeInTheDocument();
    expect(screen.getByTestId('share-screen')).toBeInTheDocument();
    expect(screen.getByTestId('leave-layup')).toBeInTheDocument();

    // Not a dashboard: no directory, no participant admin, no settings.
    const pill = screen.getByTestId('compact-bar');
    expect(within(pill).queryByRole('region', { name: 'People' })).toBeNull();
    expect(pill.textContent).not.toMatch(/Happening now|visibility|organisation/i);
  });

  it('puts the other people before your own face', () => {
    renderPill();
    const tiles = screen.getAllByRole('figure');
    // In a window this small, the person you are with is the point; your own
    // face is the least interesting thing on screen.
    expect(tiles[0]).toHaveAttribute('data-testid', 'face-m-karl');
    expect(tiles.at(-1)).toHaveAttribute('data-testid', 'face-self');
  });

  it('can be dragged from anywhere the faces are', () => {
    renderPill();
    // The stage behind the faces drags the window; the control bar opts out,
    // in CSS, once, rather than each button remembering to.
    const pill = screen.getByTestId('compact-bar');
    expect(pill.querySelector('.call__stage')).toHaveClass('drag');
    expect(screen.getByRole('contentinfo')).toHaveClass('no-drag');
  });

  it('offers sharing, or stopping, but never both', async () => {
    const handlers = renderPill();
    await userEvent.click(screen.getByTestId('share-screen'));
    expect(handlers.onShare).toHaveBeenCalled();
    expect(screen.queryByTestId('stop-sharing')).toBeNull();

    renderPill({ presenting: true });
    expect(screen.getAllByTestId('stop-sharing')).toHaveLength(1);
    expect(screen.getAllByTestId('share-screen')).toHaveLength(1); // the first render's
  });

  it('lets you out', async () => {
    const handlers = renderPill();
    await userEvent.click(screen.getByTestId('leave-layup'));
    expect(handlers.onLeave).toHaveBeenCalled();
  });
});
