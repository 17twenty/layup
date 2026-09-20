import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAvController } from './av';
import { createSession } from './session';
import { SIGNAL_OFFER, type SignalMessage } from './peer-connection';

/**
 * Changing your microphone or camera mid-call must never renegotiate.
 *
 * This release exists because a renegotiation-shaped bug killed a real call:
 * the media elements went away and the audio with them. A device switch that
 * offered again would do the same thing to somebody mid-sentence, so the test
 * that matters here is not "the dropdown works" - it is *no new offer*.
 *
 * The fake peer connection below fires `negotiationneeded` on `addTrack`,
 * exactly as a real RTCPeerConnection does. So an implementation that removed
 * and re-added a track, or built a second sender, would send an offer through
 * `sendSignal` and fail these tests. Only `replaceTrack` is silent.
 */

/** Everything that happened, in order: proof that the old track is stopped
 *  only *after* its replacement is already in the sender. */
let events: string[] = [];

class FakeSender {
  track: MediaStreamTrack | null;
  constructor(track: MediaStreamTrack) {
    this.track = track;
  }
  replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => {
    events.push(`replaceTrack:${(track as FakeTrack | null)?.id ?? 'null'}`);
    this.track = track;
  });
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  senders: FakeSender[] = [];

  onicecandidate: unknown = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: unknown = null;
  ondatachannel: unknown = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  setLocalDescription = vi.fn(async () => {
    this.localDescription = { type: 'offer', sdp: 'v=0' } as RTCSessionDescription;
  });
  async setRemoteDescription() {}
  async addIceCandidate() {}

  addTrack(track: MediaStreamTrack) {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    events.push(`addTrack:${(track as FakeTrack).id}`);
    // What a real connection does the moment the set of senders changes.
    queueMicrotask(() => this.onnegotiationneeded?.());
    return sender as unknown as RTCRtpSender;
  }
  removeTrack() {}
  createDataChannel(label: string) {
    return { label, readyState: 'open', send: vi.fn(), close: vi.fn() } as unknown as RTCDataChannel;
  }
  async getStats() {
    return { forEach: () => {} } as unknown as RTCStatsReport;
  }
  close() {}
}

interface FakeTrack extends MediaStreamTrack {
  id: string;
  stopped: boolean;
}

function fakeTrack(kind: 'audio' | 'video', id: string): FakeTrack {
  return {
    id,
    kind,
    enabled: true,
    readyState: 'live',
    stopped: false,
    stop: vi.fn(function (this: FakeTrack) {
      this.stopped = true;
      events.push(`stop:${id}`);
    }),
    addEventListener: vi.fn(),
  } as unknown as FakeTrack;
}

class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: FakeTrack) {
    this.tracks = this.tracks.filter((entry) => entry !== track);
  }
}

/** Ids of the devices `getUserMedia` will refuse, as if unplugged. */
let missing: string[] = [];
let captureCount = 0;
const asked: MediaStreamConstraints[] = [];

const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
  asked.push(constraints);
  const chosen = (kind: 'audio' | 'video') => {
    const value = constraints[kind];
    if (!value || typeof value === 'boolean') return undefined;
    const id = value.deviceId;
    if (!id) return undefined;
    return typeof id === 'string' ? id : ((id as ConstrainDOMStringParameters).exact as string);
  };
  for (const kind of ['audio', 'video'] as const) {
    const id = chosen(kind);
    if (id && missing.includes(id)) {
      const error = new Error('Requested device not found');
      error.name = 'OverconstrainedError';
      throw error;
    }
  }
  captureCount += 1;
  const tracks: FakeTrack[] = [];
  if (constraints.audio) tracks.push(fakeTrack('audio', `${chosen('audio') ?? 'default-mic'}#${captureCount}`));
  if (constraints.video) tracks.push(fakeTrack('video', `${chosen('video') ?? 'default-cam'}#${captureCount}`));
  return new FakeStream(tracks) as unknown as MediaStream;
});

/** A whole live call: a peer with our camera and microphone already published. */
async function harness() {
  const sent: Array<{ type: string; message: SignalMessage }> = [];
  const session = createSession({
    layupId: 'lay_1',
    localMembershipId: 'mem_me',
    sendSignal: (type, message) => sent.push({ type, message }),
    createRTCPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
  });

  const av = createAvController({
    getUserMedia,
    // The whole point: a replacement track is swapped into the existing
    // sender, never added as a new one.
    onTrackReplaced: (track) => void session.replaceCameraTrack(track),
  });

  session.connect('mem_them');
  const state = await av.start('mem_me', { camera: true, microphone: true });
  session.publishCamera(state.stream!);
  await settle();

  const pc = FakePeerConnection.instances[0]!;
  return {
    av,
    session,
    pc,
    sent,
    offers: () => sent.filter((entry) => entry.type === SIGNAL_OFFER),
    senderFor: (kind: 'audio' | 'video') =>
      pc.senders.find((sender) => sender.track?.kind === kind),
  };
}

/** Lets queued microtasks - including a `negotiationneeded` an implementation
 *  might have caused - actually run before anything is asserted. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  events = [];
  missing = [];
  captureCount = 0;
  asked.length = 0;
  getUserMedia.mockClear();
});

describe('switching a device mid-call', () => {
  it('publishes the call in the first place by adding tracks, which does offer', async () => {
    // The baseline the rest of this file is measured against: adding a track
    // *is* a renegotiation, and the fake peer connection reproduces that. If
    // this stopped being true, "no offer" below would prove nothing.
    const h = await harness();
    expect(h.pc.senders).toHaveLength(2);
    expect(h.offers().length).toBeGreaterThan(0);
  });

  it('changes the microphone with replaceTrack, and creates no new offer', async () => {
    const h = await harness();
    const before = h.senderFor('audio')!;
    const oldTrack = before.track as FakeTrack;
    h.sent.length = 0;
    h.pc.setLocalDescription.mockClear();

    const state = await h.av.setMicrophoneDevice('mic_usb');
    await settle();

    // The new track went into the sender that was already there.
    expect(before.replaceTrack).toHaveBeenCalledTimes(1);
    const swapped = before.replaceTrack.mock.calls[0]![0] as FakeTrack;
    expect(swapped.id).toBe('mic_usb#2');
    expect(swapped).not.toBe(oldTrack);
    expect(h.senderFor('audio')).toBe(before);

    // THE assertion this task exists for.
    expect(h.offers()).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.pc.setLocalDescription).not.toHaveBeenCalled();
    // No second m-line, and no transceiver was touched.
    expect(h.pc.senders).toHaveLength(2);

    // The old device is released, but only once its replacement is live.
    expect(oldTrack.stopped).toBe(true);
    expect(events.indexOf('replaceTrack:mic_usb#2')).toBeLessThan(events.indexOf(`stop:${oldTrack.id}`));
    expect(state.microphoneId).toBe('mic_usb');
    expect(state.error).toBeUndefined();
  });

  it('changes the camera the same way', async () => {
    const h = await harness();
    const before = h.senderFor('video')!;
    const oldTrack = before.track as FakeTrack;
    h.sent.length = 0;
    h.pc.setLocalDescription.mockClear();

    const state = await h.av.setCameraDevice('cam_usb');
    await settle();

    expect(before.replaceTrack).toHaveBeenCalledTimes(1);
    expect(h.offers()).toHaveLength(0);
    expect(h.pc.setLocalDescription).not.toHaveBeenCalled();
    expect(h.pc.senders).toHaveLength(2);
    expect(oldTrack.stopped).toBe(true);
    expect(state.cameraId).toBe('cam_usb');
  });

  it('asks only for the one device it is changing', async () => {
    const h = await harness();
    asked.length = 0;

    await h.av.setMicrophoneDevice('mic_usb');

    // Re-opening the camera to change the microphone would flash the light and
    // drop the video for no reason.
    expect(asked).toEqual([{ audio: { deviceId: { exact: 'mic_usb' } } }]);
  });

  it('leaves the other track completely alone', async () => {
    const h = await harness();
    const video = h.senderFor('video')!;
    const videoTrack = video.track as FakeTrack;

    await h.av.setMicrophoneDevice('mic_usb');
    await settle();

    expect(video.replaceTrack).not.toHaveBeenCalled();
    expect(videoTrack.stopped).toBe(false);
  });

  it('keeps mute across a switch, because mute is the person, not the device', async () => {
    const h = await harness();
    h.av.setMicrophone(false);

    const state = await h.av.setMicrophoneDevice('mic_usb');

    const track = h.senderFor('audio')!.track as FakeTrack;
    expect(track.enabled).toBe(false);
    expect(state.muted).toBe(true);
  });

  it('keeps the same MediaStream object, so nothing on screen remounts', async () => {
    const h = await harness();
    const stream = h.av.state().stream;

    await h.av.setMicrophoneDevice('mic_usb');

    // The tiles hold this object. A new one would be a new srcObject, and the
    // last time media elements were replaced mid-call the audio died.
    expect(h.av.state().stream).toBe(stream);
    expect(stream!.getAudioTracks()).toHaveLength(1);
    expect(stream!.getTracks()).toHaveLength(2);
  });

  it('falls back to the default when the chosen device has vanished', async () => {
    const h = await harness();
    const before = h.senderFor('audio')!;
    const oldTrack = before.track as FakeTrack;
    missing = ['mic_gone'];
    h.sent.length = 0;

    const state = await h.av.setMicrophoneDevice('mic_gone');
    await settle();

    // A dead track left in the sender is silence nobody can explain, so the
    // default device takes over instead.
    expect(before.replaceTrack).toHaveBeenCalledTimes(1);
    const swapped = before.replaceTrack.mock.calls[0]![0] as FakeTrack;
    expect(swapped.id).toMatch(/^default-mic/);
    expect(swapped.readyState).toBe('live');
    expect(oldTrack.stopped).toBe(true);
    expect(state.microphoneId).toBeUndefined();
    expect(state.deviceNotice).toMatch(/no longer available/i);
    // Still no renegotiation, even down the failure path.
    expect(h.offers()).toHaveLength(0);
  });

  it('keeps the call it has when even the default refuses', async () => {
    const h = await harness();
    const before = h.senderFor('audio')!;
    const oldTrack = before.track as FakeTrack;
    h.sent.length = 0;
    getUserMedia.mockImplementationOnce(async () => {
      const error = new Error('nope');
      error.name = 'NotReadableError';
      throw error;
    });
    getUserMedia.mockImplementationOnce(async () => {
      const error = new Error('nope');
      error.name = 'NotReadableError';
      throw error;
    });

    const state = await h.av.setMicrophoneDevice('mic_usb');
    await settle();

    // Better a working microphone you did not pick than no microphone at all.
    expect(before.replaceTrack).not.toHaveBeenCalled();
    expect(oldTrack.stopped).toBe(false);
    expect(state.error).toMatch(/already in use/);
    expect(h.offers()).toHaveLength(0);
  });

  it('does nothing at all before the devices are open', async () => {
    const av = createAvController({ getUserMedia });
    const state = await av.setMicrophoneDevice('mic_usb');
    expect(state.stream).toBeUndefined();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('remembers the speaker without touching the peer connection', async () => {
    const h = await harness();
    h.sent.length = 0;

    const state = h.av.setSpeaker('spk_1');

    expect(state.speakerId).toBe('spk_1');
    expect(h.sent).toHaveLength(0);
    expect(h.senderFor('audio')!.replaceTrack).not.toHaveBeenCalled();
  });
});
