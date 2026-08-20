/**
 * A layup with nobody sharing is still a layup (SPEC.md §7.1).
 *
 * The point of these tests is what *does not* happen: stopping a share, or the
 * presenter walking out, must leave the peer connections, the memberships and
 * the audio and video exactly where they were. The screen is a feature of a
 * layup, not the reason one exists.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSession } from './session';
import { SIGNAL_BYE, type SignalMessage } from './peer-connection';
import {
  TYPE_SCREEN_STARTED,
  TYPE_SCREEN_STOPPED,
  TYPE_SCREEN_TAKEOVER,
  createShareStore,
} from './share-store';

class FakeSender {
  track: MediaStreamTrack | null;
  constructor(track: MediaStreamTrack) {
    this.track = track;
  }
  replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => {
    this.track = track;
  });
}

class FakePeer {
  static instances: FakePeer[] = [];
  connectionState: RTCPeerConnectionState = 'connected';
  iceConnectionState: RTCIceConnectionState = 'connected';
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

  constructor() {
    FakePeer.instances.push(this);
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  addTrack(track: MediaStreamTrack) {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender as unknown as RTCRtpSender;
  }
  removeTrack() {}
  createDataChannel(label: string) {
    return { label, readyState: 'open', send: vi.fn(), close: vi.fn() } as unknown as RTCDataChannel;
  }
  async getStats() {
    return { forEach: () => {} } as unknown as RTCStatsReport;
  }
  close() {
    this.closed = true;
  }
  deliver(stream: MediaStream, track: MediaStreamTrack) {
    this.ontrack?.({ streams: [stream], track } as unknown as RTCTrackEvent);
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

const streamOf = (...tracks: MediaStreamTrack[]) =>
  ({
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getTracks: () => tracks,
  }) as unknown as MediaStream;

function harness() {
  FakePeer.instances = [];
  const sent: Array<{ type: string; payload: SignalMessage }> = [];
  const session = createSession({
    layupId: 'lay_abc12345',
    localMembershipId: 'mem_local',
    sendSignal: (type, payload) => sent.push({ type, payload }),
    createRTCPeerConnection: () => new FakePeer() as unknown as RTCPeerConnection,
  });
  return { session, sent, peers: () => FakePeer.instances };
}

describe('a layup with no screen', () => {
  it('keeps the connection and the camera when the share stops', () => {
    const { session, peers } = harness();
    session.connect('mem_karl');
    session.publishCamera(streamOf(fakeTrack('video'), fakeTrack('audio')));
    session.publishScreen(streamOf(fakeTrack('video')));
    expect(peers()[0]!.senders).toHaveLength(3);

    session.unpublishScreen();

    // The screen sender is emptied, not removed: the peer connection, the
    // camera and the microphone carry on untouched.
    expect(peers()[0]!.closed).toBe(false);
    expect(session.localScreen()).toBeUndefined();
    expect(peers()[0]!.senders).toHaveLength(3);
    expect(peers()[0]!.senders.filter((sender) => sender.track !== null)).toHaveLength(2);
    expect(session.remotes()).toHaveLength(1);
  });

  it('clears the screen but keeps everybody else when the presenter leaves', async () => {
    const { session } = harness();
    session.connect('mem_karl');
    session.connect('mem_sam');
    session.setPresenter('mem_karl');

    const screen = streamOf(fakeTrack('video'));
    const karlPeer = FakePeer.instances[0]!;
    karlPeer.deliver(screen, screen.getVideoTracks()[0]!);
    expect(session.remotes().find((remote) => remote.membershipId === 'mem_karl')?.screen).toBe(screen);

    // Karl walks out.
    await session.handleSignal(SIGNAL_BYE, {
      layupId: 'lay_abc12345',
      fromMembershipId: 'mem_karl',
    } as SignalMessage);
    session.disconnect('mem_karl', 'they left the layup');

    const remaining = session.remotes();
    expect(remaining.map((remote) => remote.membershipId)).toEqual(['mem_sam']);
    // Sam's connection is untouched: the layup did not end, it just lost a screen.
    expect(FakePeer.instances[1]!.closed).toBe(false);
  });

  it('lets the next person share', () => {
    const { session } = harness();
    session.connect('mem_karl');
    session.connect('mem_sam');
    session.setPresenter('mem_karl');
    FakePeer.instances[0]!.deliver(streamOf(fakeTrack('video')), fakeTrack('video'));
    session.disconnect('mem_karl');

    // Sam picks up the screen. Nothing had to be rebuilt for that to work.
    session.setPresenter('mem_sam');
    const samScreen = streamOf(fakeTrack('video'));
    FakePeer.instances[1]!.deliver(samScreen, samScreen.getVideoTracks()[0]!);

    expect(session.remotes().find((remote) => remote.membershipId === 'mem_sam')?.screen).toBe(samScreen);
  });

  it('treats no-screen as a state, not an error', () => {
    const store = createShareStore({ membershipId: () => 'mem_local' });

    store.apply(TYPE_SCREEN_STARTED, {
      id: 'shr_1',
      presenterMembershipId: 'mem_local',
      allowDrawing: true,
      allowPointer: false,
      allowKeyboard: false,
    });
    store.apply(TYPE_SCREEN_STOPPED, {});

    // No error, no notice, no share - just a layup.
    expect(store.state()).toEqual({ share: undefined });
    expect(store.isPresenting()).toBe(false);

    // Losing it to somebody else says so, and still leaves a usable layup.
    store.apply(TYPE_SCREEN_TAKEOVER, { takenByName: 'Karl' });
    expect(store.state().share).toBeUndefined();
    expect(store.state().notice?.kind).toBe('takeover');
  });
});

/**
 * A guest closing their browser tab is one peer's business (SPEC.md §7.1).
 *
 * This is the shape of the 0.3.1 report: a guest left, and the presenter's
 * screen stopped going anywhere while the border still said "You are sharing
 * this screen". The cause was that a peer's departure was applied to
 * *session-wide* state - the peers map and the `screenSenders`/`cameraSenders`
 * maps that `publishScreen`, `unpublishScreen` and `replaceCameraTrack` all
 * iterate - without the per-peer teardown `disconnect()` does, and without
 * telling anybody. So a departed peer's dead sender stayed inside the loop
 * carrying the presenter's screen, and one throw from it abandoned the loop
 * before the live peer was reached.
 */
class ClosingPeer extends FakePeer {
  /** A closed RTCPeerConnection throws InvalidStateError from addTrack. */
  override addTrack(track: MediaStreamTrack) {
    if (this.closed) throw new Error('InvalidStateError: RTCPeerConnection is closed');
    return super.addTrack(track);
  }
}

function closingHarness() {
  FakePeer.instances = [];
  const sent: Array<{ type: string; payload: SignalMessage }> = [];
  const rosters: string[][] = [];
  const session = createSession({
    layupId: 'lay_abc12345',
    localMembershipId: 'mem_local',
    sendSignal: (type, payload) => sent.push({ type, payload }),
    createRTCPeerConnection: () => new ClosingPeer() as unknown as RTCPeerConnection,
    onChange: (peers) => rosters.push(peers.map((peer) => peer.membershipId)),
  });
  return { session, sent, rosters, peers: () => FakePeer.instances };
}

describe('a guest walks out of a layup that is being presented to', () => {
  it('closes that peer and nothing else, and keeps the screen on the others', async () => {
    const { session, peers } = closingHarness();
    session.connect('mem_karl');
    session.connect('mem_guest');
    session.publishCamera(streamOf(fakeTrack('video'), fakeTrack('audio')));
    session.publishScreen(streamOf(fakeTrack('video')));
    const karl = peers()[0]!;

    await session.handleSignal(SIGNAL_BYE, {
      layupId: 'lay_abc12345',
      fromMembershipId: 'mem_guest',
    } as SignalMessage);

    expect(peers()[1]!.closed).toBe(true);
    // The layup outlives one guest: Karl's connection, camera and screen are
    // exactly where they were.
    expect(karl.closed).toBe(false);
    expect(session.localScreen()).toBeDefined();
    expect(karl.senders.filter((sender) => sender.track !== null)).toHaveLength(3);
    expect(session.remotes().map((peer) => peer.membershipId)).toEqual(['mem_karl']);
  });

  it('tells the room, so the tile leaves with them', async () => {
    const { session, rosters } = closingHarness();
    session.connect('mem_karl');
    session.connect('mem_guest');
    rosters.length = 0;

    await session.handleSignal(SIGNAL_BYE, {
      layupId: 'lay_abc12345',
      fromMembershipId: 'mem_guest',
    } as SignalMessage);

    // Without this the UI never hears about the departure and the tile sits
    // at "reconnecting…" for ever.
    expect(rosters.at(-1)).toEqual(['mem_karl']);
  });

  it('takes its senders with it, so a session-wide swap never touches a closed peer', async () => {
    const { session, peers } = closingHarness();
    session.connect('mem_karl');
    session.connect('mem_guest');
    session.publishCamera(streamOf(fakeTrack('video'), fakeTrack('audio')));
    session.publishScreen(streamOf(fakeTrack('video')));
    const guestSenders = peers()[1]!.senders;

    await session.handleSignal(SIGNAL_BYE, {
      layupId: 'lay_abc12345',
      fromMembershipId: 'mem_guest',
    } as SignalMessage);
    guestSenders.forEach((sender) => sender.replaceTrack.mockClear());

    // Changing a microphone, and stopping the share, are session-wide loops.
    // Neither may reach into a connection that has been closed.
    await session.replaceCameraTrack(fakeTrack('audio'));
    session.unpublishScreen();

    for (const sender of guestSenders) expect(sender.replaceTrack).not.toHaveBeenCalled();
  });

  it('does not let one dead peer abandon the publish loop', () => {
    const { session, peers } = closingHarness();
    session.connect('mem_guest');
    session.connect('mem_karl');
    // A peer whose connection Chromium has already closed underneath us. The
    // presenter's screen still has to reach everybody after it in the loop.
    (peers()[0] as ClosingPeer).closed = true;

    expect(() => session.publishScreen(streamOf(fakeTrack('video')))).not.toThrow();
    expect(() => session.publishCamera(streamOf(fakeTrack('video'), fakeTrack('audio')))).not.toThrow();
    expect(peers()[1]!.senders.filter((sender) => sender.track !== null)).toHaveLength(3);
  });
});
