import { describe, expect, it, vi } from 'vitest';
import { createSession } from './session';
import { SIGNAL_BYE, SIGNAL_OFFER, type SignalMessage } from './peer-connection';

class FakeSender {
  track: MediaStreamTrack | null;
  constructor(track: MediaStreamTrack) {
    this.track = track;
  }
  replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => {
    this.track = track;
  });
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  senders: FakeSender[] = [];
  closed = false;

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
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description as RTCSessionDescription;
  }
  async addIceCandidate() {}
  addTrack(track: MediaStreamTrack) {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender as unknown as RTCRtpSender;
  }
  removeTrack() {}
  createDataChannel(label: string) {
    return { label } as RTCDataChannel;
  }
  async getStats() {
    return { forEach: () => {} } as unknown as RTCStatsReport;
  }
  close() {
    this.closed = true;
  }

  /** Simulates the far side publishing a screen. */
  deliverTrack(stream: MediaStream, track: MediaStreamTrack) {
    this.ontrack?.({ streams: [stream], track } as unknown as RTCTrackEvent);
  }
  transitionTo(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function fakeTrack(kind = 'video') {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    kind,
    stop: vi.fn(),
    addEventListener: (event: string, handler: () => void) => {
      (listeners[event] ??= []).push(handler);
    },
    end: () => listeners.ended?.forEach((handler) => handler()),
  } as unknown as MediaStreamTrack & { end(): void };
}

function fakeStream(track: MediaStreamTrack) {
  return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

function harness() {
  FakePeerConnection.instances = [];
  const sent: Array<{ type: string; payload: SignalMessage }> = [];
  const changes: number[] = [];
  const session = createSession({
    layupId: 'lay_abc12345',
    localMembershipId: 'mem_local',
    sendSignal: (type, payload) => sent.push({ type, payload }),
    createRTCPeerConnection: (config) => new FakePeerConnection(config) as unknown as RTCPeerConnection,
    onChange: (peers) => changes.push(peers.length),
  });
  return { session, sent, changes, peers: () => FakePeerConnection.instances };
}

describe('layup media session', () => {
  it('publishes the shared desktop to a peer', () => {
    const h = harness();
    h.session.connect('mem_remote', { initiate: true });

    const track = fakeTrack();
    h.session.publishScreen(fakeStream(track));

    const pc = h.peers()[0]!;
    expect(pc.senders).toHaveLength(1);
    expect(pc.senders[0]?.track).toBe(track);
    expect(h.session.localScreen()).toBeTruthy();
  });

  it('publishes to a peer that joins after sharing started', () => {
    const h = harness();
    h.session.publishScreen(fakeStream(fakeTrack()));
    h.session.connect('mem_late');

    expect(h.peers()[0]?.senders).toHaveLength(1);
  });

  it('replaces the track instead of adding a second share', () => {
    const h = harness();
    h.session.connect('mem_remote');
    h.session.publishScreen(fakeStream(fakeTrack()));

    const second = fakeTrack();
    h.session.publishScreen(fakeStream(second));

    const pc = h.peers()[0]!;
    // Exactly one shared desktop per layup (ADR-0007).
    expect(pc.senders).toHaveLength(1);
    expect(pc.senders[0]?.replaceTrack).toHaveBeenCalledWith(second);
  });

  it('renders a remote screen and clears it when the track ends', () => {
    const h = harness();
    h.session.connect('mem_remote');
    // The control plane says this membership is the presenter.
    h.session.setPresenter('mem_remote');

    const track = fakeTrack();
    const stream = fakeStream(track);
    h.peers()[0]!.deliverTrack(stream, track);

    expect(h.session.remotes()[0]?.screen).toBe(stream);

    (track as unknown as { end(): void }).end();
    expect(h.session.remotes()[0]?.screen).toBeUndefined();
  });

  it('stops publishing without touching the peer connection', () => {
    const h = harness();
    h.session.connect('mem_remote');
    h.session.publishScreen(fakeStream(fakeTrack()));

    h.session.unpublishScreen();

    const pc = h.peers()[0]!;
    expect(pc.senders[0]?.replaceTrack).toHaveBeenCalledWith(null);
    expect(pc.closed).toBe(false); // the layup survives the share ending
    expect(h.session.localScreen()).toBeUndefined();
  });

  it('opens a connection when an offer arrives from someone new', async () => {
    const h = harness();
    await h.session.handleSignal(SIGNAL_OFFER, {
      layupId: 'lay_abc12345',
      toMembershipId: 'mem_local',
      fromMembershipId: 'mem_remote',
      sdp: 'v=0 offer',
    });

    expect(h.session.remotes().map((remote) => remote.membershipId)).toEqual(['mem_remote']);
    expect(h.peers()[0]?.remoteDescription?.sdp).toBe('v=0 offer');
  });

  it('ignores signalling for a different layup', async () => {
    const h = harness();
    await h.session.handleSignal(SIGNAL_OFFER, {
      layupId: 'lay_someoneelse',
      toMembershipId: 'mem_local',
      fromMembershipId: 'mem_remote',
      sdp: 'v=0',
    });
    expect(h.session.remotes()).toHaveLength(0);
  });

  it('forgets a peer that says goodbye', async () => {
    const h = harness();
    h.session.connect('mem_remote');
    await h.session.handleSignal(SIGNAL_BYE, {
      layupId: 'lay_abc12345',
      toMembershipId: 'mem_local',
      fromMembershipId: 'mem_remote',
      reason: 'they left',
    });
    expect(h.session.remotes()).toHaveLength(0);
  });

  it('reports each peer connection state to the UI', () => {
    const h = harness();
    h.session.connect('mem_remote');
    h.peers()[0]!.transitionTo('connected');

    expect(h.session.remotes()[0]?.connection.connected).toBe(true);
    expect(h.changes.length).toBeGreaterThan(1);
  });

  it('closes every peer when the session ends', () => {
    const h = harness();
    h.session.connect('mem_a');
    h.session.connect('mem_b');
    h.session.close('leaving the layup');

    expect(h.peers().every((pc) => pc.closed)).toBe(true);
    expect(h.session.remotes()).toHaveLength(0);
  });
});

describe('camera and microphone on the session', () => {
  it('publishes camera and microphone tracks to every peer', () => {
    const h = harness();
    h.session.connect('mem_a');
    h.session.connect('mem_b');

    const video = fakeTrack('video');
    const audio = fakeTrack('audio');
    const stream = {
      getTracks: () => [video, audio],
      getVideoTracks: () => [video],
    } as unknown as MediaStream;
    h.session.publishCamera(stream);

    expect(h.peers()[0]?.senders).toHaveLength(2);
    expect(h.peers()[1]?.senders).toHaveLength(2);
  });

  it('classifies incoming video by who the domain says is presenting', () => {
    const h = harness();
    h.session.connect('mem_remote');

    // Nobody is presenting: an incoming video track is a camera.
    const cameraStream = fakeStream(fakeTrack('video'));
    h.peers()[0]!.deliverTrack(cameraStream, fakeTrack('video'));
    expect(h.session.remotes()[0]?.camera).toBe(cameraStream);
    expect(h.session.remotes()[0]?.screen).toBeUndefined();

    // Once the control plane says they are presenting, it is the screen.
    h.session.setPresenter('mem_remote');
    const screenStream = fakeStream(fakeTrack('video'));
    h.peers()[0]!.deliverTrack(screenStream, fakeTrack('video'));
    expect(h.session.remotes()[0]?.screen).toBe(screenStream);
  });
});
