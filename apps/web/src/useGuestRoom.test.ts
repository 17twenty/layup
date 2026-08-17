import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  envelope,
  PROTOCOL_VERSION,
  QUERY_PROTOCOL_VERSION,
  QUERY_TOKEN,
  TYPE_CURSOR_MOVE,
} from '@layup/protocol';
import { CHANNEL_ANNOTATION, CHANNEL_CURSOR, CHANNEL_INPUT } from '@core/data-channels';
import type { RealtimeSocket } from '@core/realtime-client';
import { useGuestRoom } from './useGuestRoom';
import type { GuestJoinResult } from './guest-client';

const HOST = 'mem_host';
const ME = 'mem_guest';
const SOURCE = 'screen:1:0';

const guest: GuestJoinResult = {
  guestToken: 'gst_secret',
  membershipId: ME,
  iceServers: [{ urls: ['stun:stun.example:3478'] }],
  layup: {
    id: 'lay_1',
    organisationId: 'org_1',
    title: 'Thursday sync',
    visibility: 'LINK',
    active: true,
    createdAt: '2026-08-17T09:00:00Z',
    hasCreatorAuthority: true,
    participants: [
      {
        membershipId: HOST,
        userId: 'usr_host',
        displayName: 'Nick',
        joinedAt: '2026-08-17T09:00:00Z',
        isCreatorMembership: true,
      },
      {
        membershipId: ME,
        userId: 'usr_guest',
        displayName: 'Sam',
        joinedAt: '2026-08-17T09:05:00Z',
        isCreatorMembership: false,
        isGuest: true,
      },
    ],
    activeShare: {
      id: 'shr_1',
      presenterMembershipId: HOST,
      sourceId: SOURCE,
      allowDrawing: true,
      allowPointer: false,
      allowKeyboard: false,
    },
  },
};

class FakeChannel {
  readyState = 'open';
  sent: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly label: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  channels: FakeChannel[] = [];
  added: Array<{ track: MediaStreamTrack; stream: MediaStream }> = [];

  onicecandidate: unknown = null;
  onnegotiationneeded: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  ondatachannel: unknown = null;

  constructor(readonly config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  async setLocalDescription() {
    this.localDescription = { type: 'offer', sdp: 'v=0' } as RTCSessionDescription;
  }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  addTrack(track: MediaStreamTrack, stream: MediaStream) {
    this.added.push({ track, stream });
    return { track, replaceTrack: vi.fn(async () => {}) } as unknown as RTCRtpSender;
  }
  removeTrack() {}
  createDataChannel(label: string) {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }
  async getStats() {
    return { forEach: () => {} } as unknown as RTCStatsReport;
  }
  close() {}

  channel(label: string) {
    return this.channels.find((each) => each.label === label);
  }
  labels() {
    return this.channels.map((each) => each.label);
  }
  deliver(stream: MediaStream, track: MediaStreamTrack) {
    this.ontrack?.({ streams: [stream], track } as unknown as RTCTrackEvent);
  }
}

function fakeTrack(kind: string, id: string): MediaStreamTrack {
  return {
    kind,
    id,
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function fakeStream(id: string, tracks: MediaStreamTrack[]): MediaStream {
  return {
    id,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
  } as unknown as MediaStream;
}

let sockets: Array<{ url: string; socket: RealtimeSocket; sent: string[] }>;
let getUserMedia: ReturnType<typeof vi.fn>;
let camera: MediaStream;

function harness() {
  return renderHook(() =>
    useGuestRoom({
      serverUrl: 'https://layup.example',
      guest,
      createRTCPeerConnection: (config) => new FakePeerConnection(config) as unknown as RTCPeerConnection,
      getUserMedia: getUserMedia as unknown as (c: MediaStreamConstraints) => Promise<MediaStream>,
      socketFactory: (url) => {
        const sent: string[] = [];
        const socket: RealtimeSocket = {
          send: (data) => sent.push(data),
          close: () => {},
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
        };
        sockets.push({ url, socket, sent });
        return socket;
      },
    }),
  );
}

/** The one peer a 1:1 guest call has. */
async function peer() {
  await waitFor(() => expect(FakePeerConnection.instances.length).toBeGreaterThan(0));
  return FakePeerConnection.instances[0] as FakePeerConnection;
}

beforeEach(() => {
  sockets = [];
  FakePeerConnection.instances = [];
  camera = fakeStream('camera', [fakeTrack('video', 'cam'), fakeTrack('audio', 'mic')]);
  getUserMedia = vi.fn(async () => camera);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a guest in a call', () => {
  it('signals with the guest token as a query parameter, as the desktop does', async () => {
    harness();
    await waitFor(() => expect(sockets.length).toBe(1));

    const url = new URL(sockets[0]!.url);
    expect(url.pathname).toBe('/api/realtime');
    expect(url.protocol).toBe('wss:');
    expect(url.searchParams.get(QUERY_TOKEN)).toBe('gst_secret');
    expect(url.searchParams.get(QUERY_PROTOCOL_VERSION)).toBe(String(PROTOCOL_VERSION));
    // No dev-user fallback: a guest has a real, server-issued credential.
    expect(url.searchParams.get('devUser')).toBeNull();
  });

  it('opens cursor-fast and input-reliable, and never annotation-fast', async () => {
    harness();
    const connection = await peer();

    await waitFor(() => expect(connection.labels().length).toBeGreaterThan(0));
    // Guests do not draw. The channel is not merely unused - it is never opened.
    expect(connection.labels().sort()).toEqual([CHANNEL_CURSOR, CHANNEL_INPUT].sort());
    expect(connection.labels()).not.toContain(CHANNEL_ANNOTATION);
  });

  it('adds no sender for a screen track: a guest watches, it does not share', async () => {
    harness();
    const connection = await peer();

    await waitFor(() => expect(connection.added.length).toBe(2));
    // Camera and microphone, and nothing else. A screen track would be a
    // third sender carrying a stream this side never captured.
    expect(connection.added.map((each) => each.stream.id)).toEqual(['camera', 'camera']);
    expect(connection.added.map((each) => each.track.kind).sort()).toEqual(['audio', 'video']);
    expect((navigator.mediaDevices as { getDisplayMedia?: unknown } | undefined)?.getDisplayMedia)
      .toBeUndefined();
  });

  it('shows the shared screen once one arrives', async () => {
    const { result } = harness();
    const connection = await peer();

    expect(result.current.screen).toBeUndefined();

    const screen = fakeStream('screen', [fakeTrack('video', 'scr')]);
    act(() => connection.deliver(screen, screen.getVideoTracks()[0]!));

    // Classified as the shared desktop because the control plane says this
    // membership is presenting, not because of track order (ADR-0007).
    await waitFor(() => expect(result.current.screen?.id).toBe('screen'));
  });

  it('turns the camera and the microphone off and on again', async () => {
    const { result } = harness();
    await waitFor(() => expect(result.current.av.stream).toBeDefined());

    expect(result.current.av.cameraEnabled).toBe(true);
    expect(result.current.av.microphoneEnabled).toBe(true);

    act(() => result.current.setCamera(false));
    await waitFor(() => expect(result.current.av.cameraEnabled).toBe(false));
    expect(camera.getVideoTracks()[0]!.enabled).toBe(false);

    act(() => result.current.setMicrophone(false));
    await waitFor(() => expect(result.current.av.muted).toBe(true));
    expect(camera.getAudioTracks()[0]!.enabled).toBe(false);

    act(() => result.current.setMicrophone(true));
    await waitFor(() => expect(result.current.av.muted).toBe(false));
    expect(camera.getAudioTracks()[0]!.enabled).toBe(true);
  });

  it('sends pointer positions normalised to the shared surface, 0..1', async () => {
    const { result } = harness();
    const connection = await peer();
    await waitFor(() => expect(connection.channel(CHANNEL_CURSOR)).toBeDefined());

    act(() => result.current.moveCursor({ x: 480, y: 300, width: 1920, height: 1200 }));

    const cursor = connection.channel(CHANNEL_CURSOR) as FakeChannel;
    await waitFor(() => expect(cursor.sent.length).toBe(1));
    expect(cursor.sent[0]).toMatchObject({
      type: TYPE_CURSOR_MOVE,
      membershipId: ME,
      // The presenter's capture source: the one name both ends agree on.
      displayId: SOURCE,
      x: 0.25,
      y: 0.25,
    });
  });

  it('follows the layup as the control plane keeps describing it', async () => {
    const { result } = harness();
    await waitFor(() => expect(sockets.length).toBe(1));

    const next = {
      ...guest.layup,
      title: 'Thursday sync (extended)',
      activeShare: undefined,
    };
    act(() => {
      sockets[0]!.socket.onmessage?.({ data: JSON.stringify(envelope('layup.state', next)) });
    });

    await waitFor(() => expect(result.current.layup.title).toBe('Thursday sync (extended)'));
    // Sharing stopped: nothing is being presented any more.
    expect(result.current.presenterMembershipId).toBeUndefined();
  });
});
