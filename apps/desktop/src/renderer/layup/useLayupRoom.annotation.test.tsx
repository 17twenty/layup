import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { CHANNEL_ANNOTATION, type ChannelName } from '../../core/data-channels';
import type { LayupStateResponse, ShareStateResponse } from '../../shared/ipc';
import { useLayupRoom } from './useLayupRoom';

/**
 * The live drawing path, not a guard in a jar.
 *
 * `annotation-guard.ts` is tested on its own; this proves it is actually in
 * the way. A guest opening `annotation-fast` anyway - which takes a one-line
 * change to their copy of the browser client, because the channel ids are
 * negotiated and fixed - draws nothing on this machine.
 */
const ME = 'mem_me';
const KARL = 'mem_karl';
const WEB_GUEST = 'mem_webguest';

interface FakeChannels {
  on(name: ChannelName, handler: (message: unknown, channel: ChannelName) => void): () => void;
  send(name: ChannelName, message: unknown): boolean;
  isOpen(name: ChannelName): boolean;
  dropped(name: ChannelName): number;
  close(): void;
  deliver(name: ChannelName, message: unknown): void;
}

function fakeChannels(): FakeChannels {
  const handlers = new Map<string, Set<(message: unknown, channel: ChannelName) => void>>();
  return {
    on(name, handler) {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    send: () => true,
    isOpen: () => true,
    dropped: () => 0,
    close: () => {},
    deliver(name, message) {
      for (const handler of handlers.get(name) ?? []) handler(message, name);
    },
  };
}

const channelsByPeer = new Map<string, FakeChannels>();

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
  channels: (membershipId: string) => channelsByPeer.get(membershipId),
  disconnect: vi.fn(),
  close: vi.fn(),
};

vi.mock('../../core/session', () => ({ createSession: () => session }));

const share: ShareStateResponse = {
  share: {
    id: 'shr_1',
    presenterMembershipId: KARL,
    sourceId: 'screen:1:0',
    allowDrawing: true,
    allowPointer: false,
    allowKeyboard: false,
  },
};

/** The roster as the control plane describes it: one member, one link guest. */
function layupState(): LayupStateResponse {
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
          membershipId: KARL,
          userId: 'usr_devkarlx',
          displayName: 'Karl',
          joinedAt: '2026-08-17T09:01:00Z',
          isCreatorMembership: false,
          isGuest: false,
        },
        {
          membershipId: WEB_GUEST,
          userId: 'usr_gvisitor',
          displayName: 'Sam',
          joinedAt: '2026-08-17T09:02:00Z',
          isCreatorMembership: false,
          isGuest: true,
        },
      ],
    },
  };
}

const stroke = (membershipId: string, strokeId: string) => [
  {
    type: 'stroke.begin',
    strokeId,
    membershipId,
    displayId: 'screen:1:0',
    colour: '#ff0000',
    width: 0.004,
  },
  {
    type: 'stroke.points',
    strokeId,
    membershipId,
    index: 0,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
    ],
  },
];

describe('drawing that arrives from a peer', () => {
  beforeEach(() => {
    channelsByPeer.clear();
    channelsByPeer.set(KARL, fakeChannels());
    channelsByPeer.set(WEB_GUEST, fakeChannels());
    (window as unknown as { layup: unknown }).layup = {
      ice: { config: async () => ({ iceServers: [], forceRelay: false }) },
      signal: { send: async () => {}, onReceived: () => () => {} },
      control: { onSend: () => () => {} },
      input: { offer: async () => ({ injected: false }) },
    };
  });

  it('draws a member, and never a guest holding a link', async () => {
    const view = renderHook(() => useLayupRoom({ layup: layupState(), share }));
    // The session is built once the ICE configuration lands; the roster effect
    // wires the peers on the render after that.
    await waitFor(() => expect(session.setPresenter).toHaveBeenCalled());
    view.rerender();
    await waitFor(() => expect(channelsByPeer.get(KARL)).toBeDefined());

    act(() => {
      for (const message of stroke(KARL, 'str_member')) {
        channelsByPeer.get(KARL)?.deliver(CHANNEL_ANNOTATION, message);
      }
      for (const message of stroke(WEB_GUEST, 'str_guest')) {
        channelsByPeer.get(WEB_GUEST)?.deliver(CHANNEL_ANNOTATION, message);
      }
    });

    await waitFor(() => expect(view.result.current.strokes).toHaveLength(1));
    expect(view.result.current.strokes[0]).toMatchObject({
      strokeId: 'str_member',
      membershipId: KARL,
    });
    expect(view.result.current.strokes.map((entry) => entry.membershipId)).not.toContain(WEB_GUEST);
  });

  it('ignores a guest clearing everybody else s drawing', async () => {
    const view = renderHook(() => useLayupRoom({ layup: layupState(), share }));
    await waitFor(() => expect(session.setPresenter).toHaveBeenCalled());
    view.rerender();

    act(() => {
      for (const message of stroke(KARL, 'str_member')) {
        channelsByPeer.get(KARL)?.deliver(CHANNEL_ANNOTATION, message);
      }
    });
    await waitFor(() => expect(view.result.current.strokes).toHaveLength(1));

    act(() => {
      channelsByPeer
        .get(WEB_GUEST)
        ?.deliver(CHANNEL_ANNOTATION, { type: 'stroke.clear', membershipId: WEB_GUEST });
    });

    // A wipe is drawing traffic too, and a guest's is ignored like the rest.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.result.current.strokes).toHaveLength(1);
  });
});
