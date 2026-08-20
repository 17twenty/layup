import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { LayupStateResponse, ShareStateResponse } from '../../shared/ipc';
import { useLayupRoom } from './useLayupRoom';

/**
 * Somebody who has gone, and somebody whose wifi hiccuped, are not the same
 * thing (0.3.1, item 2).
 *
 * A browser guest closed their tab and their tile sat at "Someone
 * reconnecting…" for the rest of the call. The roster is the only thing that
 * can tell the two apart: a peer whose *membership* is still active is
 * reconnecting, and a membership the control plane has marked as left is a
 * departure. The room was reading neither - it connected to every participant
 * in the list, `leftAt` or not, so a membership that had left was reconnected
 * to on the very next roster update.
 */
const ME = 'mem_me';
const KARL = 'mem_karl';
const GUEST = 'mem_webguest';

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

vi.mock('../../core/session', () => ({ createSession: () => session }));

const share: ShareStateResponse = {};

interface Person {
  membershipId: string;
  isGuest: boolean;
  leftAt?: string;
}

function layupState(people: Person[]): LayupStateResponse {
  return {
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
      participants: people.map((person) => ({
        membershipId: person.membershipId,
        userId: person.isGuest ? 'usr_gvisitor' : `usr_dev${person.membershipId}`,
        displayName: person.membershipId === GUEST ? 'Sam' : 'Karl',
        joinedAt: '2026-08-17T09:00:00Z',
        isCreatorMembership: person.membershipId === ME,
        isGuest: person.isGuest,
        ...(person.leftAt ? { leftAt: person.leftAt } : {}),
      })),
    },
  };
}

const here: Person[] = [
  { membershipId: ME, isGuest: false },
  { membershipId: KARL, isGuest: false },
  { membershipId: GUEST, isGuest: true },
];

const guestGone: Person[] = [
  { membershipId: ME, isGuest: false },
  { membershipId: KARL, isGuest: false },
  { membershipId: GUEST, isGuest: true, leftAt: '2026-08-17T09:30:00Z' },
];

describe('a guest who has gone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('is disconnected, and never connected to again', async () => {
    const view = renderHook((props: { people: Person[] }) => useLayupRoom({ layup: layupState(props.people), share }), {
      initialProps: { people: here },
    });
    await waitFor(() => expect(session.setPresenter).toHaveBeenCalled());
    view.rerender({ people: here });
    await waitFor(() => expect(session.connect).toHaveBeenCalledWith(GUEST));

    session.connect.mockClear();
    view.rerender({ people: guestGone });

    await waitFor(() => expect(session.disconnect).toHaveBeenCalledWith(GUEST, expect.any(String)));
    // A membership that has left is not somebody to reconnect to, and the
    // roster arrives again on every layup update.
    view.rerender({ people: guestGone });
    expect(session.connect).not.toHaveBeenCalledWith(GUEST);
    // Karl was never touched.
    expect(session.disconnect).not.toHaveBeenCalledWith(KARL, expect.anything());
  });

  it('is not confused with a peer who is merely reconnecting', async () => {
    const view = renderHook((props: { people: Person[] }) => useLayupRoom({ layup: layupState(props.people), share }), {
      initialProps: { people: here },
    });
    await waitFor(() => expect(session.setPresenter).toHaveBeenCalled());
    view.rerender({ people: here });
    await waitFor(() => expect(session.connect).toHaveBeenCalledWith(GUEST));

    // The same roster again: a flapping peer connection is not a departure,
    // and nobody may be dropped for it.
    view.rerender({ people: here });
    view.rerender({ people: here });
    expect(session.disconnect).not.toHaveBeenCalled();
  });
});
