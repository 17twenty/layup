import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CapturePermissionResponse,
  LayupStateResponse,
  PermissionsResponse,
  ShareStateResponse,
} from '../../shared/ipc';
import { LayupRoom } from './LayupRoom';

/**
 * Picking a screen, end to end, against the *real* capture hook.
 *
 * The other room tests replace `useLocalCapture` with a stub that always has
 * sources, which is exactly what hid this: in the running application the
 * room's list is only ever filled by somebody asking for it. So here the hook
 * is real and only the IPC underneath it is stubbed - the shape the bug lived
 * in.
 */
const ME = 'mem_me';

const layup: LayupStateResponse = {
  membershipId: ME,
  youAreCreatorMembership: true,
  layup: {
    id: 'lay_abc12345',
    organisationId: 'org_devlayup',
    title: 'Pairing',
    visibility: 'LINK',
    active: true,
    createdAt: '2026-08-14T09:00:00Z',
    hasCreatorAuthority: true,
    creatorMembershipId: ME,
    participants: [
      {
        membershipId: ME,
        userId: 'usr_devnickx',
        displayName: 'Nick',
        joinedAt: '2026-08-14T09:00:00Z',
        isCreatorMembership: true,
        isGuest: false,
      },
    ],
  },
};

const room = {
  remotes: [] as unknown[],
  av: { cameraEnabled: true, microphoneEnabled: true, muted: false },
  setCamera: vi.fn(),
  setMicrophone: vi.fn(),
  devices: { microphones: [], cameras: [], speakers: [], labelsHidden: false },
  refreshDevices: vi.fn(),
  setMicrophoneDevice: vi.fn(),
  setCameraDevice: vi.fn(),
  setSpeaker: vi.fn(),
  sampleCursors: () => [],
  strokes: [],
  identify: () => ({ colour: '#fff', label: '' }),
  moveCursor: vi.fn(),
  scopes: [] as string[],
  input: {
    pointerDown: vi.fn(),
    pointerUp: vi.fn(),
    pointerWheel: vi.fn(),
    keyDown: vi.fn(),
    keyUp: vi.fn(),
  },
  targetDisplayId: undefined,
  diagnostics: {} as Record<string, unknown>,
};

vi.mock('./useLayupRoom', () => ({ useLayupRoom: () => room }));

const startShare = vi.fn(async () => ({}) as ShareStateResponse);
const sources = vi.fn(async () => ({
  sources: [
    { id: 'screen:1:0', name: 'Display 1', kind: 'screen' as const },
    { id: 'window:9:0', name: 'Editor', kind: 'window' as const },
  ],
}));
const capturePermission = vi.fn(
  async (): Promise<CapturePermissionResponse> => ({
    status: 'granted',
    canCapture: true,
    guidance: '',
    canOpenSettings: true,
    platform: 'darwin',
  }),
);
const getUserMedia = vi.fn(
  async () => ({ getTracks: () => [{ stop: vi.fn(), kind: 'video' }] }) as unknown as MediaStream,
);

/**
 * macOS permissions, as the room asks for them (task 9). Granted here unless a
 * test says otherwise; Accessibility is the one that matters to this surface.
 */
const grantedPermission = {
  status: 'granted' as const,
  ok: true,
  guidance: '',
  canOpenSettings: true,
  canRequest: false,
};
const permissionsAll = vi.fn(
  async (): Promise<PermissionsResponse> => ({
    camera: grantedPermission,
    microphone: grantedPermission,
    screen: grantedPermission,
    accessibility: grantedPermission,
  }),
);
const openAccessibilitySettings = vi.fn(async () => true);

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks leaves implementations behind, and the picker asks for the
  // permission too - so these are set per test rather than "once".
  capturePermission.mockResolvedValue({
    status: 'granted',
    canCapture: true,
    guidance: '',
    canOpenSettings: true,
    platform: 'darwin',
  });
  getUserMedia.mockResolvedValue({
    getTracks: () => [{ stop: vi.fn(), kind: 'video' }],
  } as unknown as MediaStream);

  Object.defineProperty(window, 'layup', {
    configurable: true,
    value: {
      share: {
        current: async () => ({}) as ShareStateResponse,
        onChanged: () => () => {},
        start: startShare,
        stop: vi.fn(),
        ask: vi.fn(),
      },
      control: {
        sharing: async () => ({
          allowed: { pointer: false, keyboard: false },
          stopped: [],
          anyoneHasControl: false,
        }),
        onChanged: () => () => {},
        onSend: () => () => {},
        allow: vi.fn(),
        stop: vi.fn(),
        resume: vi.fn(),
        stopAll: vi.fn(),
      },
      input: { offer: vi.fn() },
      capture: {
        sources,
        permission: capturePermission,
        openSettings: async () => true,
      },
      permissions: {
        all: permissionsAll,
        request: async () => true,
        openSettings: openAccessibilitySettings,
      },
      ice: { config: async () => ({ iceServers: [], forceRelay: false }) },
      ui: { setMode: async (mode: string) => ({ mode }), onMode: () => () => {} },
      signal: { send: async () => true, onReceived: () => () => {} },
    },
  });

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
});

describe('choosing a screen to share', () => {
  it('shares the source that was clicked', async () => {
    render(<LayupRoom layup={layup} />);

    await userEvent.click(await screen.findByTestId('share-screen'));
    await userEvent.click(await screen.findByTestId('source-window:9:0'));

    // Chromium is asked for that source, and the layup is told about it.
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({
            mandatory: expect.objectContaining({ chromeMediaSourceId: 'window:9:0' }),
          }),
        }),
      ),
    );
    await waitFor(() => expect(startShare).toHaveBeenCalledWith('window:9:0'));
    expect(screen.queryByTestId('room-error')).toBeNull();
  });

  it('enumerates the sources once, because there is one list', async () => {
    render(<LayupRoom layup={layup} />);
    await userEvent.click(await screen.findByTestId('share-screen'));
    await screen.findByTestId('source-screen:1:0');

    // Two components each asking the operating system for the windows is the
    // defect itself: whichever list the click is checked against goes stale.
    expect(sources).toHaveBeenCalledTimes(1);
  });
});

/**
 * The refusal that used to be silent (task 9).
 *
 * `getUserMedia` was refused, the picker closed, and the share was announced
 * anyway - so the layup was told somebody was presenting, and what arrived was
 * nothing. The cause is nearly always the Screen Recording permission, which
 * is the one thing worth saying.
 */
describe('a screen macOS will not hand over', () => {
  it('says so, and announces no share at all', async () => {
    getUserMedia.mockRejectedValue(new Error('Could not start video source'));

    render(<LayupRoom layup={layup} />);
    await userEvent.click(await screen.findByTestId('share-screen'));
    await userEvent.click(await screen.findByTestId('source-screen:1:0'));

    const error = await screen.findByTestId('room-error');
    expect(error).toBeInTheDocument();
    // Nobody is told there is a screen to look at when there is not.
    expect(startShare).not.toHaveBeenCalled();
  });

  it('points at the permission rather than at Chromium', async () => {
    getUserMedia.mockRejectedValue(new Error('Could not start video source'));
    capturePermission.mockResolvedValue({
      status: 'denied',
      canCapture: false,
      guidance:
        'macOS is blocking screen recording for Layup. Open Privacy & Security → Screen Recording, tick Layup, then restart it.',
      canOpenSettings: true,
      platform: 'darwin',
    });

    render(<LayupRoom layup={layup} />);
    await userEvent.click(await screen.findByTestId('share-screen'));
    await userEvent.click(await screen.findByTestId('source-screen:1:0'));

    // "Could not start video source" tells nobody what to do about it.
    expect(await screen.findByTestId('room-error')).toHaveTextContent(
      /Privacy & Security.*Screen Recording/,
    );
  });

  it('falls back to the raw refusal when nothing can say why', async () => {
    getUserMedia.mockRejectedValue(new Error('Could not start video source'));
    capturePermission.mockRejectedValue(new Error('no answer'));

    render(<LayupRoom layup={layup} />);
    await userEvent.click(await screen.findByTestId('share-screen'));
    await userEvent.click(await screen.findByTestId('source-screen:1:0'));

    expect(await screen.findByTestId('room-error')).toHaveTextContent(
      /Could not start video source/,
    );
    expect(startShare).not.toHaveBeenCalled();
  });
});
