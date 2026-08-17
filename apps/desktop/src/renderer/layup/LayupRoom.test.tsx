import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  LayupStateResponse,
  PermissionsResponse,
  RemoteControlStateResponse,
  ShareStateResponse,
} from '../../shared/ipc';
import { LayupRoom } from './LayupRoom';

/**
 * The room is wiring, so these tests are about what it wires to *what*: the
 * presenter gets switches, a viewer gets a screen, and a viewer's clicks only
 * leave this machine once the presenter has said they may.
 */
const ME = 'mem_me';
const KARL = 'mem_karl';

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
      { membershipId: ME, userId: 'usr_devnickx', displayName: 'Nick', joinedAt: '2026-08-14T09:00:00Z', isCreatorMembership: true },
      { membershipId: KARL, userId: 'usr_devkarlx', displayName: 'Karl', joinedAt: '2026-08-14T09:01:00Z', isCreatorMembership: false },
    ],
  },
};

const idleControl: RemoteControlStateResponse = {
  allowed: { pointer: false, keyboard: false },
  stopped: [],
  anyoneHasControl: false,
};

let shareState: ShareStateResponse;
let controlState: RemoteControlStateResponse;
const api = {
  allow: vi.fn(async () => idleControl),
  stop: vi.fn(async () => idleControl),
  resume: vi.fn(async () => idleControl),
  stopAll: vi.fn(async () => idleControl),
  startShare: vi.fn(async () => ({}) as ShareStateResponse),
  stopShare: vi.fn(async () => ({}) as ShareStateResponse),
  ask: vi.fn(async () => ({}) as ShareStateResponse),
  offer: vi.fn(async () => ({ injected: true })),
};

// The live half is exercised on its own; here it is replaced so the wiring is
// what is under test.
/** A peer whose screen has arrived - which is what puts the window in viewer. */
const sharingPeer = {
  membershipId: KARL,
  displayName: 'Karl',
  screen: {} as MediaStream,
  connection: { connected: true },
};

/** A peer whose camera has arrived: these tiles are where the audio lives. */
const karlOnCamera = {
  membershipId: KARL,
  displayName: 'Karl',
  camera: {} as MediaStream,
  connection: { connected: true },
};

const room = {
  remotes: [] as unknown[],
  av: { cameraEnabled: true, microphoneEnabled: true, muted: false } as Record<string, unknown>,
  setCamera: vi.fn(),
  setMicrophone: vi.fn(),
  devices: {
    microphones: [
      { deviceId: 'mic_built_in', label: 'MacBook Microphone' },
      { deviceId: 'mic_usb', label: 'Yeti Stereo Microphone' },
    ],
    cameras: [{ deviceId: 'cam_1', label: 'FaceTime HD Camera' }],
    speakers: [{ deviceId: 'spk_1', label: 'MacBook Speakers' }],
    labelsHidden: false,
  },
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
  targetDisplayId: 'screen:1:0',
  diagnostics: {} as Record<string, unknown>,
};

vi.mock('./useLayupRoom', () => ({ useLayupRoom: () => room }));

// One stub object, not a fresh one per render: a hook that hands back new
// function identities every render restarts every effect that depends on them.
const capture = vi.hoisted(() => ({
  sources: [{ id: 'screen:1:0', name: 'Display 1', kind: 'screen' }],
  refresh: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../capture/useLocalCapture', () => ({ useLocalCapture: () => capture }));

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
  // clearAllMocks leaves implementations in place, so a test that says
  // Accessibility is missing would say it for every test after it.
  permissionsAll.mockResolvedValue({
    camera: grantedPermission,
    microphone: grantedPermission,
    screen: grantedPermission,
    accessibility: grantedPermission,
  });
  shareState = {};
  controlState = idleControl;
  room.scopes = [];
  room.remotes = [];
  room.av = { cameraEnabled: true, microphoneEnabled: true, muted: false };

  Object.defineProperty(window, 'layup', {
    configurable: true,
    value: {
      share: {
        current: async () => shareState,
        onChanged: () => () => {},
        start: api.startShare,
        stop: api.stopShare,
        ask: api.ask,
      },
      control: {
        sharing: async () => controlState,
        onChanged: () => () => {},
        onSend: () => () => {},
        allow: api.allow,
        stop: api.stop,
        resume: api.resume,
        stopAll: api.stopAll,
      },
      input: { offer: api.offer },
      capture: {
        permission: async () => ({
          status: 'granted' as const,
          canCapture: true,
          guidance: '',
          canOpenSettings: true,
          platform: 'darwin',
        }),
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
});

/**
 * jsdom gives every element a zero-sized box, and a zero-sized surface has no
 * meaningful normalised position - the room refuses to guess one. Giving the
 * surface a size is what makes a click mean something here.
 */
function measure(element: HTMLElement, width = 800, height = 400) {
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

describe('the live layup', () => {
  it('stays small while you are the one sharing, with the switches to hand', async () => {
    shareState = {
      share: {
        id: 'shr_1',
        presenterMembershipId: ME,
        sourceId: 'screen:1:0',
        allowDrawing: true,
        allowPointer: false,
        allowKeyboard: false,
      },
    };
    render(<LayupRoom layup={layup} />);

    await waitFor(() => expect(screen.getByTestId('allow-pointer')).toBeInTheDocument());
    // Presenting is not a reason to grow: you are looking at your own screen.
    expect(screen.getByTestId('compact-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('room-surface')).toBeNull();
    expect(screen.getByTestId('stop-sharing')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('allow-pointer'));
    expect(api.allow).toHaveBeenCalledWith('pointer', true);
  });

  it('shows a viewer the screen, and no switches for a machine that is not theirs', async () => {
    room.remotes = [sharingPeer];
    shareState = {
      share: {
        id: 'shr_1',
        presenterMembershipId: KARL,
        sourceId: 'screen:9:0',
        allowDrawing: true,
        allowPointer: false,
        allowKeyboard: false,
      },
    };
    render(<LayupRoom layup={layup} />);

    await waitFor(() => expect(screen.getByTestId('room-surface')).toBeInTheDocument());
    expect(screen.queryByTestId('allow-pointer')).toBeNull();
    expect(screen.queryByTestId('stop-sharing')).toBeNull();
    // Somebody else is presenting, so asking is on offer.
    expect(screen.getByTestId('ask-to-share')).toBeInTheDocument();
  });

  it('sends nothing from a viewer who has not been given control', async () => {
    room.remotes = [sharingPeer];
    render(<LayupRoom layup={layup} />);
    const surface = await screen.findByTestId('room-surface');
    measure(surface);

    await userEvent.pointer({ target: surface, coords: { clientX: 200, clientY: 100 }, keys: '[MouseLeft]' });

    // The cursor is an overlay and always moves; the click does not travel.
    expect(room.input.pointerDown).not.toHaveBeenCalled();
    expect(screen.queryByTestId('controlling-hint')).toBeNull();
  });

  it('forwards a click once the presenter has granted control', async () => {
    room.scopes = ['pointer'];
    room.remotes = [sharingPeer];
    render(<LayupRoom layup={layup} />);
    const surface = await screen.findByTestId('room-surface');
    measure(surface);

    await userEvent.pointer({ target: surface, coords: { clientX: 200, clientY: 100 }, keys: '[MouseLeft]' });

    expect(room.input.pointerDown).toHaveBeenCalledWith(
      expect.objectContaining({ displayId: 'screen:1:0', button: 'left' }),
    );
    expect(room.input.pointerUp).toHaveBeenCalled();
    expect(screen.getByTestId('controlling-hint')).toHaveTextContent('pointer');
  });

  it('forwards keys only while the shared screen is focused', async () => {
    room.scopes = ['keyboard'];
    room.remotes = [sharingPeer];
    render(<LayupRoom layup={layup} />);
    const surface = await screen.findByTestId('room-surface');

    await userEvent.keyboard('a');
    // Typing into the application itself is not remote control.
    expect(room.input.keyDown).not.toHaveBeenCalled();

    surface.focus();
    await userEvent.keyboard('a');
    expect(room.input.keyDown).toHaveBeenCalledWith('KeyA');
  });

  it('shows the banner and stops everything in one press', async () => {
    controlState = {
      allowed: { pointer: true, keyboard: false },
      stopped: [],
      anyoneHasControl: true,
      shortcut: 'Ctrl+Alt+Shift+\\',
    };
    room.remotes = [sharingPeer];
    render(<LayupRoom layup={layup} />);

    const banner = await screen.findByTestId('remote-control-banner');
    expect(banner).toHaveTextContent('Everyone here can use your mouse');

    await userEvent.click(screen.getByTestId('stop-all'));
    expect(api.stopAll).toHaveBeenCalled();
  });
});

/**
 * The media elements are the call. A remote <video> is unmuted - it *is* the
 * audio output - so anything that unmounts one drops the other person's voice
 * mid-sentence. Every one of these asserts the *same element instance*
 * survives: a remount leaves a node in the document while restarting the
 * stream, which would pass a weaker test and still be the bug.
 */
describe('the media never stops', () => {
  it('keeps the faces and the shared screen mounted while the picker is open', async () => {
    room.remotes = [{ ...karlOnCamera, screen: {} as MediaStream }];
    render(<LayupRoom layup={layup} />);

    const face = (await screen.findByTestId(`face-${KARL}`)).querySelector('video');
    const shared = screen.getByTestId('shared-screen');
    expect(face).toBeTruthy();

    await userEvent.click(screen.getByTestId('share-screen'));
    await screen.findByTestId('cancel-picker');

    expect(screen.queryByTestId(`face-${KARL}`)?.querySelector('video')).toBe(face);
    expect(screen.queryByTestId('shared-screen')).toBe(shared);
  });

  it('keeps the faces mounted when somebody starts sharing', async () => {
    room.remotes = [karlOnCamera];
    const view = render(<LayupRoom layup={layup} />);
    const face = (await screen.findByTestId(`face-${KARL}`)).querySelector('video');
    expect(face).toBeTruthy();

    // Karl's screen arrives: the window grows, but nobody's camera or
    // microphone restarts because of it.
    room.remotes = [{ ...karlOnCamera, screen: {} as MediaStream }];
    view.rerender(<LayupRoom layup={layup} />);
    await screen.findByTestId('room-surface');

    expect(screen.queryByTestId(`face-${KARL}`)?.querySelector('video')).toBe(face);
  });

  it('changes the microphone from the call bar without touching the media elements', async () => {
    room.remotes = [karlOnCamera];
    render(<LayupRoom layup={layup} />);
    const face = (await screen.findByTestId(`face-${KARL}`)).querySelector('video');

    await userEvent.click(screen.getByTestId('choose-microphone'));
    await userEvent.click(screen.getByTestId('device-mic_usb'));

    // The switch is a replaceTrack behind this call - never a new offer, and
    // never a new element for the audio to be lost in.
    expect(room.setMicrophoneDevice).toHaveBeenCalledWith('mic_usb');
    expect(screen.queryByTestId(`face-${KARL}`)?.querySelector('video')).toBe(face);
  });

  it('changes the speaker and the camera from the same bar', async () => {
    room.remotes = [karlOnCamera];
    render(<LayupRoom layup={layup} />);
    await screen.findByTestId(`face-${KARL}`);

    await userEvent.click(screen.getByTestId('choose-microphone'));
    await userEvent.click(screen.getByTestId('device-spk_1'));
    expect(room.setSpeaker).toHaveBeenCalledWith('spk_1');

    await userEvent.click(screen.getByTestId('choose-camera'));
    await userEvent.click(screen.getByTestId('device-cam_1'));
    expect(room.setCameraDevice).toHaveBeenCalledWith('cam_1');
  });
});

/**
 * Where a missing Accessibility grant actually bites (task 9).
 *
 * The presenter's switches are the only place remote control is turned on, so
 * they are the only place the truth about it matters. Flipping "Mouse" with
 * the permission missing is a switch that appears to work and does nothing -
 * the failure the helper's own source calls the worst available.
 */
describe('remote control the OS will not allow', () => {
  const presentingShare = {
    share: {
      id: 'shr_1',
      presenterMembershipId: ME,
      sourceId: 'screen:1:0',
      allowDrawing: true,
      allowPointer: false,
      allowKeyboard: false,
    },
  };

  it('replaces the switches with the guidance and a way to fix it', async () => {
    shareState = presentingShare;
    permissionsAll.mockResolvedValue({
      camera: grantedPermission,
      microphone: grantedPermission,
      screen: grantedPermission,
      accessibility: {
        status: 'denied' as const,
        ok: false,
        guidance: 'Open Privacy & Security → Accessibility, tick Layup, then restart it.',
        canOpenSettings: true,
        canRequest: false,
      },
    });

    render(<LayupRoom layup={layup} />);

    await waitFor(() =>
      expect(screen.getByTestId('control-accessibility')).toHaveTextContent(/Accessibility/),
    );
    expect(screen.queryByTestId('allow-pointer')).toBeNull();

    await userEvent.click(screen.getByTestId('open-accessibility-settings'));
    expect(openAccessibilitySettings).toHaveBeenCalledWith('accessibility');
  });

  it('asks the privileged side, never the renderer, and only while presenting', async () => {
    shareState = {};
    render(<LayupRoom layup={layup} />);

    await waitFor(() => expect(screen.getByTestId('compact-bar')).toBeInTheDocument());
    // Not presenting: there are no switches to be wrong about.
    expect(permissionsAll).not.toHaveBeenCalled();
  });

  it('leaves the switches alone when the helper says macOS is happy', async () => {
    shareState = presentingShare;
    render(<LayupRoom layup={layup} />);

    await waitFor(() => expect(screen.getByTestId('allow-pointer')).toBeInTheDocument());
    expect(screen.queryByTestId('control-accessibility')).toBeNull();
  });
});
