import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import type {
  LayupStateResponse,
  PermissionsResponse,
  UpdateStateResponse,
} from '../shared/ipc';

// The room's own wiring (media, signalling, remote control) is exercised in
// LayupRoom.test.tsx. Here App is under test - specifically, that it renders
// the shell's title bar around every view, including the room - so the room
// is stood in for by something that needs none of that machinery.
vi.mock('./layup/LayupRoom', () => ({
  LayupRoom: () => <div data-testid="room">stub room</div>,
}));

/**
 * The bridge, with a server answer that can be held open.
 *
 * `server:state` is an IPC round trip, so the first paint happens before the
 * answer arrives. These tests pin down what is on screen in that gap: nothing
 * the answer might contradict, and no request to a server nobody has added.
 */
const granted = {
  status: 'granted' as const,
  ok: true,
  guidance: '',
  canOpenSettings: true,
  canRequest: false,
};

function bridge(serverState: Promise<unknown>) {
  const people = { list: vi.fn(async () => ({ people: [] })), onChanged: vi.fn(() => () => {}) };
  const layup = {
    current: vi.fn(async (): Promise<LayupStateResponse> => ({ youAreCreatorMembership: false })),
    create: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    open: vi.fn(async () => ({ layups: [] })),
    onChanged: vi.fn(() => () => {}),
  };
  const value = {
    protocolVersion: 1,
    app: { info: vi.fn() },
    server: {
      state: vi.fn(() => serverState),
      add: vi.fn(),
      forget: vi.fn(),
      onChanged: vi.fn(() => () => {}),
      onPrefill: vi.fn(() => () => {}),
    },
    capture: {
      sources: vi.fn(async () => ({ sources: [] })),
      permission: vi.fn(async () => ({
        status: 'granted',
        canCapture: true,
        guidance: '',
        canOpenSettings: false,
        platform: 'darwin',
      })),
      openSettings: vi.fn(),
    },
    permissions: {
      all: vi.fn(
        async (): Promise<PermissionsResponse> => ({
          camera: granted,
          microphone: granted,
          screen: granted,
          accessibility: granted,
        }),
      ),
      request: vi.fn(async () => true),
      openSettings: vi.fn(async () => true),
    },
    control: { status: vi.fn(async () => undefined) },
    identity: { current: vi.fn(async () => undefined) },
    people,
    requests: {
      list: vi.fn(async () => ({ incoming: [], outgoing: [] })),
      invite: vi.fn(),
      accept: vi.fn(),
      decline: vi.fn(),
      cancel: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    layup,
    ui: { setMode: vi.fn(async () => ({ mode: 'home' })), onMode: vi.fn(() => () => {}) },
    update: {
      state: vi.fn(async (): Promise<UpdateStateResponse> => ({ status: 'idle' })),
      install: vi.fn(async () => false),
      onChanged: vi.fn(() => () => {}),
    },
    realtime: {
      status: vi.fn(async () => ({ status: 'idle', attempt: 0 })),
      onState: vi.fn(() => () => {}),
    },
    preferences: {
      get: vi.fn(async () => ({ soundsMuted: false })),
      set: vi.fn(async (next: { soundsMuted: boolean }) => next),
    },
    attention: {
      onAlert: vi.fn(() => () => {}),
    },
  };
  Object.defineProperty(window, 'layup', { value, configurable: true, writable: true });
  return value;
}

describe('bootstrap shell', () => {
  it('renders the product identity and the protocol version', async () => {
    bridge(Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }));

    render(<App />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Layup');
    expect(screen.getByText(/protocol v\d+/)).toBeTruthy();
    // People are the home surface, not a meeting wizard.
    expect(screen.getByRole('region', { name: 'People' })).toBeTruthy();
    expect(screen.queryByText(/new meeting/i)).toBeNull();
  });

  it('says which build this is, in a string somebody can read back to us', async () => {
    bridge(Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }));

    render(<App />);

    // v0.2.0 (abc1234) - never "vundefined", never "(undefined)".
    const meta = await screen.findByText(/protocol v\d+/);
    expect(meta.textContent).toMatch(/^v\d+\.\d+\.\d+\S* \(([0-9a-f]{7,40}|dev)\) · protocol v\d+$/);
    expect(meta.textContent).not.toMatch(/undefined/);
  });

  it('keeps the restart affordance in the footer, where a layup never shows one', async () => {
    const api = bridge(
      Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }),
    );
    api.update.state.mockResolvedValue({ status: 'ready', version: '0.3.0' });

    const { container } = render(<App />);

    const restart = await screen.findByRole('button', { name: /restart layup/i });
    // Footer chrome, not an overlay: the layup shell renders no footer at all,
    // so this can never appear over a call.
    expect(container.querySelector('footer.shell__footer')?.contains(restart)).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows nothing but the add-server screen when no server has been added', async () => {
    bridge(Promise.resolve({ configured: false }));

    render(<App />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Add a server');
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
    expect(screen.queryByText(/protocol v\d+/)).toBeNull();
    expect(screen.queryByText('People → Layup → Share → Collaborate')).toBeNull();
  });

  it('waits for the answer rather than painting a screen it may have to take back', async () => {
    // The answer never comes: this is the first frame, held open.
    const api = bridge(new Promise(() => {}));

    render(<App />);

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
    // And nothing has been asked of a server nobody has added yet.
    expect(api.people.list).not.toHaveBeenCalled();
    expect(api.layup.current).not.toHaveBeenCalled();
    expect(api.identity.current).not.toHaveBeenCalled();
    expect(api.control.status).not.toHaveBeenCalled();
    expect(api.realtime.status).not.toHaveBeenCalled();
    expect(api.requests.list).not.toHaveBeenCalled();
  });
});

/**
 * The strip behind the traffic lights (task 11): rendered once by the shell,
 * above whichever view is on screen, so a new screen cannot forget it.
 */
describe('the title bar drag strip', () => {
  it('is present before the server answer has arrived', () => {
    bridge(new Promise(() => {}));

    render(<App />);

    const titlebar = screen.getByTestId('titlebar');
    expect(titlebar).toHaveClass('drag');
  });

  it('is present on the add-server screen, which has no header of its own', async () => {
    bridge(Promise.resolve({ configured: false }));

    render(<App />);

    await screen.findByRole('heading', { level: 1 });
    const titlebar = screen.getByTestId('titlebar');
    expect(titlebar).toHaveClass('drag');
    // Its own interactive control opts out, or it becomes unclickable.
    expect(screen.getByTestId('mute-toggle')).toHaveClass('no-drag');
  });

  it('is present on the home/People screen', async () => {
    bridge(Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }));

    render(<App />);

    await screen.findByRole('region', { name: 'People' });
    expect(screen.getByTestId('titlebar')).toHaveClass('drag');
    expect(screen.getByTestId('mute-toggle')).toHaveClass('no-drag');
  });

  it('is present in the layup room, which renders no shell header at all', async () => {
    const api = bridge(
      Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }),
    );
    api.layup.current.mockResolvedValue({
      youAreCreatorMembership: true,
      layup: {
        id: 'lay_1',
        organisationId: 'org_1',
        visibility: 'PRIVATE',
        active: true,
        createdAt: '2026-08-17T00:00:00Z',
        hasCreatorAuthority: true,
        participants: [],
      },
      membershipId: 'mem_1',
    });

    render(<App />);

    await screen.findByTestId('room');
    expect(screen.getByTestId('titlebar')).toHaveClass('drag');
    expect(screen.queryByRole('heading', { level: 1, name: 'Layup' })).toBeNull();
  });
});

/**
 * Permissions, before the call rather than during it (task 9).
 *
 * Two people paired for the first time and spent the call in System Settings.
 * The screen is skippable - it must never be a wall between somebody and the
 * person waiting for them - but Screen Recording needs a restart, so the way
 * back to it is permanent.
 */
const missing = {
  status: 'denied' as const,
  ok: false,
  guidance: 'macOS is not letting Layup control this Mac.',
  canOpenSettings: true,
  canRequest: false,
};

describe('asking for permissions after registration', () => {
  it('shows the permissions screen when something is missing', async () => {
    const api = bridge(
      Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }),
    );
    api.permissions.all.mockResolvedValue({
      camera: granted,
      microphone: granted,
      screen: granted,
      accessibility: missing,
    });

    render(<App />);

    expect(await screen.findByTestId('permission-accessibility')).toBeInTheDocument();
    // And it is a screen, not a modal over the directory.
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
  });

  it('is skippable, and the directory is right there behind it', async () => {
    const api = bridge(
      Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }),
    );
    api.permissions.all.mockResolvedValue({
      camera: granted,
      microphone: granted,
      screen: missing,
      accessibility: granted,
    });

    render(<App />);

    await userEvent.click(await screen.findByTestId('permissions-done'));
    expect(await screen.findByRole('region', { name: 'People' })).toBeInTheDocument();
  });

  it('leaves a way back, because screen recording needs a restart', async () => {
    const api = bridge(
      Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }),
    );
    api.permissions.all.mockResolvedValue({
      camera: granted,
      microphone: granted,
      screen: missing,
      accessibility: granted,
    });

    render(<App />);

    await userEvent.click(await screen.findByTestId('permissions-done'));
    const link = await screen.findByTestId('open-permissions');
    // The footer says so, rather than making somebody remember.
    expect(link).toHaveTextContent(/something is missing/i);

    await userEvent.click(link);
    expect(await screen.findByTestId('permission-screen')).toBeInTheDocument();
  });

  it('is reachable from the footer even when nothing is missing', async () => {
    bridge(
      Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }),
    );

    render(<App />);

    const link = await screen.findByTestId('open-permissions');
    expect(link).toHaveTextContent(/^Permissions$/);
    await userEvent.click(link);
    expect(await screen.findByTestId('permission-camera')).toBeInTheDocument();
  });

  it('never puts a permission screen over a live layup', async () => {
    const api = bridge(
      Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }),
    );
    api.permissions.all.mockResolvedValue({
      camera: missing,
      microphone: missing,
      screen: missing,
      accessibility: missing,
    });
    api.layup.current.mockResolvedValue({
      youAreCreatorMembership: true,
      layup: {
        id: 'lay_1',
        organisationId: 'org_1',
        visibility: 'PRIVATE',
        active: true,
        createdAt: '2026-08-17T00:00:00Z',
        hasCreatorAuthority: true,
        participants: [],
      },
      membershipId: 'mem_1',
    });

    render(<App />);

    // The call wins. Permissions are asked for before one, never during.
    expect(await screen.findByTestId('room')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-camera')).toBeNull();
  });

  it('asks nothing of the OS before a server has been added', async () => {
    const api = bridge(Promise.resolve({ configured: false }));

    render(<App />);

    await screen.findByRole('heading', { level: 1 });
    expect(api.permissions.all).not.toHaveBeenCalled();
  });

  it('keeps the title bar on the permissions screen', async () => {
    const api = bridge(
      Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }),
    );
    api.permissions.all.mockResolvedValue({
      camera: granted,
      microphone: granted,
      screen: granted,
      accessibility: missing,
    });

    render(<App />);

    await screen.findByTestId('permission-accessibility');
    expect(screen.getByTestId('titlebar')).toHaveClass('drag');
    expect(screen.getByTestId('mute-toggle')).toHaveClass('no-drag');
  });
});
