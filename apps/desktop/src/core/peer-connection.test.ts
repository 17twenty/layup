import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ICE_SERVERS,
  SIGNAL_ANSWER,
  SIGNAL_BYE,
  SIGNAL_CANDIDATE,
  SIGNAL_OFFER,
  createPeerConnection,
  type SignalMessage,
} from './peer-connection';

/** A fake RTCPeerConnection: enough surface to drive negotiation logic. */
class FakePeerConnection {
  static last: FakePeerConnection | undefined;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  candidates: RTCIceCandidateInit[] = [];
  closed = false;

  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;

  constructor(readonly config: RTCConfiguration) {
    FakePeerConnection.last = this;
  }

  async setLocalDescription() {
    const type = this.remoteDescription?.type === 'offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `v=0 local ${type}` } as RTCSessionDescription;
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description as RTCSessionDescription;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.remoteDescription) throw new Error('no remote description');
    this.candidates.push(candidate);
  }

  addTrack = vi.fn(() => ({}) as RTCRtpSender);
  removeTrack = vi.fn();
  createDataChannel = vi.fn((label: string) => ({ label }) as RTCDataChannel);
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }

  transitionTo(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function harness(overrides: Partial<Parameters<typeof createPeerConnection>[0]> = {}) {
  const sent: Array<{ type: string; payload: SignalMessage }> = [];
  const peer = createPeerConnection({
    layupId: 'lay_abc12345',
    localMembershipId: 'mem_aaa',
    remoteMembershipId: 'mem_bbb',
    sendSignal: (type, payload) => sent.push({ type, payload }),
    createPeerConnection: (config) => new FakePeerConnection(config) as unknown as RTCPeerConnection,
    ...overrides,
  });
  return { peer, sent, fake: FakePeerConnection.last! };
}

describe('1:1 peer connection', () => {
  it('offers, and addresses the offer to the other membership', async () => {
    const h = harness();
    await h.peer.negotiate();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: SIGNAL_OFFER,
      payload: { layupId: 'lay_abc12345', toMembershipId: 'mem_bbb', sdp: 'v=0 local offer' },
    });
  });

  it('answers an incoming offer', async () => {
    const h = harness();
    await h.peer.accept(SIGNAL_OFFER, {
      layupId: 'lay_abc12345',
      toMembershipId: 'mem_aaa',
      sdp: 'v=0 remote offer',
    });

    expect(h.fake.remoteDescription?.type).toBe('offer');
    expect(h.sent[0]).toMatchObject({ type: SIGNAL_ANSWER, payload: { sdp: 'v=0 local answer' } });
  });

  it('sends trickled candidates as they are discovered', () => {
    const h = harness();
    h.fake.onicecandidate?.({
      candidate: {
        candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 51000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      } as RTCIceCandidate,
    });
    // The null candidate marks end-of-candidates and is not relayed.
    h.fake.onicecandidate?.({ candidate: null });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: SIGNAL_CANDIDATE,
      payload: { candidate: expect.stringContaining('typ host'), sdpMid: '0', sdpMLineIndex: 0 },
    });
  });

  it('applies remote candidates', async () => {
    const h = harness();
    await h.peer.accept(SIGNAL_OFFER, { layupId: 'l', toMembershipId: 'mem_aaa', sdp: 'v=0 offer' });
    await h.peer.accept(SIGNAL_CANDIDATE, {
      layupId: 'l',
      toMembershipId: 'mem_aaa',
      candidate: 'candidate:2 1 udp 1 10.0.0.1 4000 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    expect(h.fake.candidates).toHaveLength(1);
  });

  it('resolves glare deterministically: the impolite peer wins', async () => {
    // mem_aaa < mem_bbb, so this side is polite; the other is impolite.
    const polite = harness();
    await polite.peer.negotiate();
    polite.sent.length = 0;
    await polite.peer.accept(SIGNAL_OFFER, { layupId: 'l', toMembershipId: 'mem_aaa', sdp: 'theirs' });
    expect(polite.sent[0]?.type).toBe(SIGNAL_ANSWER); // rolled back and answered

    const impolite = harness({ localMembershipId: 'mem_zzz', remoteMembershipId: 'mem_aaa' });
    await impolite.peer.negotiate();
    impolite.sent.length = 0;
    await impolite.peer.accept(SIGNAL_OFFER, { layupId: 'l', toMembershipId: 'mem_zzz', sdp: 'theirs' });
    expect(impolite.sent).toHaveLength(0); // ignored the colliding offer
  });

  it('reports connection state and explains a failure', () => {
    const seen: string[] = [];
    const h = harness({ onStateChange: (state) => seen.push(state.connection) });

    h.fake.transitionTo('connected');
    expect(h.peer.state().connected).toBe(true);
    expect(h.peer.state().failure).toBeUndefined();

    h.fake.transitionTo('failed');
    expect(h.peer.state().connected).toBe(false);
    expect(h.peer.state().failure).toMatch(/network may be blocking/);
    expect(seen).toEqual(['connected', 'failed']);
  });

  it('uses STUN by default and relay-only when forced', () => {
    const normal = harness();
    expect((normal.fake.config.iceServers ?? []).length).toBe(DEFAULT_ICE_SERVERS.length);
    expect(normal.fake.config.iceTransportPolicy).toBeUndefined();

    const forced = harness({ forceRelay: true, iceServers: [{ urls: 'turn:turn.example:3478' }] });
    expect(forced.fake.config.iceTransportPolicy).toBe('relay');
    expect(forced.fake.config.iceServers).toEqual([{ urls: 'turn:turn.example:3478' }]);
  });

  it('says goodbye once and closes the underlying connection', () => {
    const h = harness();
    h.peer.close('leaving the layup');

    expect(h.sent[0]).toMatchObject({ type: SIGNAL_BYE, payload: { reason: 'leaving the layup' } });
    expect(h.fake.closed).toBe(true);

    h.peer.close('again');
    expect(h.sent.filter((message) => message.type === SIGNAL_BYE)).toHaveLength(1);
  });

  it('tears down when the other side says goodbye, without answering back', async () => {
    const h = harness();
    await h.peer.accept(SIGNAL_BYE, { layupId: 'l', toMembershipId: 'mem_aaa', reason: 'they left' });

    expect(h.fake.closed).toBe(true);
    expect(h.sent.filter((message) => message.type === SIGNAL_BYE)).toHaveLength(0);
    expect(h.peer.state().failure).toBe('they left');
  });

  it('renegotiates automatically when a track is added', async () => {
    const h = harness();
    h.fake.onnegotiationneeded?.();
    await vi.waitFor(() => expect(h.sent.some((message) => message.type === SIGNAL_OFFER)).toBe(true));
  });
});
