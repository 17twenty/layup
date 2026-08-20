import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { RemoteMedia } from '../../core/session';
import type { LayupStateResponse, ShareStateResponse } from '../../shared/ipc';
import { useLayupRoom } from './useLayupRoom';

/**
 * A guest has a name, and it belongs on their face (0.3.1, item 3).
 *
 * The name a guest typed reaches the participant list - the server falls back
 * to `guestStore.displayName` for somebody who is in no directory - but
 * `RemoteMedia.displayName` is set by nobody, so every tile and every "X is
 * sharing" caption read "Someone". The roster is where the answer already is.
 */
const ME = 'mem_me';
const GUEST = 'mem_webguest';

let emit: ((peers: RemoteMedia[]) => void) | undefined;

const session = {
  connect: vi.fn(),
  handleSignal: vi.fn(async () => {}),
  publishScreen: vi.fn(),
  publishCamera: vi.fn(),
  replaceCameraTrack: vi.fn(async () => {}),
  setPresenter: vi.fn(),
  unpublishScreen: vi.fn(),
  remotes: () => [],
  localScreen: () => undefined,
  diagnostics: async () => ({}),
  channels: () => undefined,
  disconnect: vi.fn(),
  close: vi.fn(),
};

vi.mock('../../core/session', () => ({
  createSession: (options: { onChange?: (peers: RemoteMedia[]) => void }) => {
    emit = options.onChange;
    return session;
  },
}));

const share: ShareStateResponse = {};

const layup: LayupStateResponse = {
  membershipId: ME,
  youAreCreatorMembership: true,
  layup: {
    id: 'lay_abc12345',
    organisationId: 'org_devlayup',
    title: 'Pairing',
    visibility: 'LINK',
    active: true,
    createdAt: '2026-08-17T09:00:00Z',
    hasCreatorAuthority: true,
    creatorMembershipId: ME,
    participants: [
      {
        membershipId: ME,
        userId: 'usr_devnickx',
        displayName: 'Nick',
        joinedAt: '2026-08-17T09:00:00Z',
        isCreatorMembership: true,
        isGuest: false,
      },
      {
        membershipId: GUEST,
        userId: 'usr_gvisitor',
        displayName: 'Sam',
        joinedAt: '2026-08-17T09:02:00Z',
        isCreatorMembership: false,
        isGuest: true,
      },
    ],
  },
};

const peer = (membershipId: string): RemoteMedia => ({
  membershipId,
  connection: { connection: 'connected', ice: 'connected', signalling: 'stable', connected: true },
});

describe('the name on a remote face', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emit = undefined;
    (window as unknown as { layup: unknown }).layup = {
      ice: { config: async () => ({ iceServers: [], forceRelay: false }) },
      signal: { send: async () => {}, onReceived: () => () => {} },
      control: { onSend: () => () => {} },
      input: { offer: async () => ({ injected: false }) },
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] }),
        enumerateDevices: async () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });

  it('is the name the guest chose, not "Someone"', async () => {
    const view = renderHook(() => useLayupRoom({ layup, share }));
    await waitFor(() => expect(emit).toBeDefined());
    view.rerender();

    act(() => emit?.([peer(GUEST)]));

    await waitFor(() => expect(view.result.current.remotes).toHaveLength(1));
    expect(view.result.current.remotes[0]?.displayName).toBe('Sam');
    // The same book the cursors and the strokes are labelled from, so one
    // person is never two names in one window.
    expect(view.result.current.identify(GUEST).label).toBe('Sam');
  });

  it('falls back to "Someone" only for a membership the roster does not name', async () => {
    const view = renderHook(() => useLayupRoom({ layup, share }));
    await waitFor(() => expect(emit).toBeDefined());
    view.rerender();

    act(() => emit?.([peer('mem_stranger')]));

    await waitFor(() => expect(view.result.current.remotes).toHaveLength(1));
    expect(view.result.current.remotes[0]?.displayName).toBe('Someone');
  });
});
