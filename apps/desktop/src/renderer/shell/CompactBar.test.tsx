import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AvState } from '../../core/av';
import type { RouteDiagnostics } from '../../core/ice-diagnostics';
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

/**
 * The connection readout has two deliberate entrances: a chip that is always
 * on screen (discoverable), and a right-click on the call surface (what was
 * actually asked for). Both must land on the same panel.
 */
describe('the connection readout, reachable in a call', () => {
  it('shows the chip in the call bar even before the first sample lands', () => {
    renderPill();
    expect(screen.getByTestId('connection-chip')).toHaveTextContent('Connecting…');
  });

  it('marks a relayed route as distinct from a direct one', () => {
    const relayed: RouteDiagnostics = { route: 'relay', relayed: true, rttMs: 120 };
    renderPill({ diagnosticsPeers: [{ membershipId: 'm-karl', label: 'Karl', diagnostics: relayed }] });
    expect(screen.getByTestId('connection-chip')).toHaveClass('connection-chip--relay');
  });

  it('names whose link each row describes', async () => {
    const direct: RouteDiagnostics = { route: 'direct', relayed: false, rttMs: 12 };
    const relayed: RouteDiagnostics = { route: 'relay', relayed: true, rttMs: 120 };
    renderPill({
      diagnosticsPeers: [
        { membershipId: 'm-karl', label: 'Karl', diagnostics: direct },
        { membershipId: 'm-guest', label: 'Sam', diagnostics: relayed },
      ],
    });
    await userEvent.click(screen.getByTestId('connection-chip'));
    expect(screen.getByTestId('connection-peer-m-karl')).toHaveTextContent('Karl');
    expect(screen.getByTestId('connection-peer-m-guest')).toHaveTextContent('Sam');
  });

  it('expands the panel when the chip is clicked', async () => {
    renderPill();
    expect(screen.queryByTestId('connection-panel')).toBeNull();
    await userEvent.click(screen.getByTestId('connection-chip'));
    expect(screen.getByTestId('connection-panel')).toBeInTheDocument();
  });

  it('offers "Connection details" from a right-click on the call surface', () => {
    renderPill();
    expect(screen.queryByTestId('connection-menu')).toBeNull();

    fireEvent.contextMenu(screen.getByTestId('compact-bar'), { clientX: 40, clientY: 60 });
    const menu = screen.getByTestId('connection-menu');
    expect(within(menu).getByText('Connection details')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('connection-details-menu-item'));
    expect(screen.getByTestId('connection-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('connection-menu')).toBeNull();
  });

  it('closes the menu without opening the panel when you click elsewhere', () => {
    renderPill();
    fireEvent.contextMenu(screen.getByTestId('compact-bar'), { clientX: 10, clientY: 10 });
    expect(screen.getByTestId('connection-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('connection-menu-scrim'));
    expect(screen.queryByTestId('connection-menu')).toBeNull();
    expect(screen.queryByTestId('connection-panel')).toBeNull();
  });
});

describe('choosing a device from the pill', () => {
  const devices = {
    microphones: [
      { deviceId: 'mic_built_in', label: 'MacBook Microphone' },
      { deviceId: 'mic_usb', label: 'Yeti Stereo Microphone' },
    ],
    cameras: [{ deviceId: 'cam_1', label: 'FaceTime HD Camera' }],
    speakers: [{ deviceId: 'spk_1', label: 'MacBook Speakers' }],
    labelsHidden: false,
  };

  it('has no carets when there is nothing to choose from', () => {
    renderPill();
    expect(screen.queryByTestId('choose-microphone')).toBeNull();
    expect(screen.queryByTestId('choose-camera')).toBeNull();
  });

  it('offers the microphone and the speaker under one caret, and the camera under its own', async () => {
    const onSelectMicrophone = vi.fn();
    const onSelectSpeaker = vi.fn();
    const onSelectCamera = vi.fn();
    renderPill({ devices, onSelectMicrophone, onSelectSpeaker, onSelectCamera });

    await userEvent.click(screen.getByTestId('choose-microphone'));
    const menu = screen.getByTestId('choose-microphone-menu');
    expect(within(menu).getByText('Microphone')).toBeInTheDocument();
    expect(within(menu).getByText('Speaker')).toBeInTheDocument();
    expect(within(menu).queryByText('Camera')).toBeNull();

    await userEvent.click(screen.getByTestId('device-mic_usb'));
    expect(onSelectMicrophone).toHaveBeenCalledWith('mic_usb');

    await userEvent.click(screen.getByTestId('choose-camera'));
    await userEvent.click(screen.getByTestId('device-cam_1'));
    expect(onSelectCamera).toHaveBeenCalledWith('cam_1');
  });

  it('ticks whatever is in use, as the controller reports it', async () => {
    renderPill({
      local: { ...av, microphoneId: 'mic_usb', speakerId: 'spk_1' },
      devices,
      onSelectMicrophone: vi.fn(),
      onSelectSpeaker: vi.fn(),
    });

    await userEvent.click(screen.getByTestId('choose-microphone'));
    expect(screen.getByTestId('device-mic_usb')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('device-mic_built_in')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('device-spk_1')).toHaveAttribute('aria-checked', 'true');
  });

  it('re-reads the devices when a list is opened', async () => {
    const onOpenDevices = vi.fn();
    renderPill({ devices, onSelectMicrophone: vi.fn(), onOpenDevices });

    await userEvent.click(screen.getByTestId('choose-microphone'));
    expect(onOpenDevices).toHaveBeenCalled();
  });

  it('asks for permission rather than listing blank rows', async () => {
    renderPill({
      devices: { ...devices, labelsHidden: true },
      onSelectMicrophone: vi.fn(),
    });

    await userEvent.click(screen.getByTestId('choose-microphone'));
    expect(screen.getByTestId('device-labels-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('device-mic_usb')).toBeNull();
  });
});
