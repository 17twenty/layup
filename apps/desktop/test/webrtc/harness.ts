/**
 * Real WebRTC proof, run inside a real Chromium (Electron) window.
 *
 * Two peer connections built by the *production* module negotiate with each
 * other through a relay that mimics the control plane, then a real video track
 * flows across. Nothing here is mocked except the network hop between them.
 */
import {
  SIGNAL_ANSWER,
  SIGNAL_CANDIDATE,
  SIGNAL_OFFER,
  createPeerConnection,
  type SignalMessage,
} from '../../src/core/peer-connection';
import { createSession } from '../../src/core/session';

declare global {
  interface Window {
    __layupWebRTC?: Promise<Record<string, unknown>>;
  }
}

async function run(): Promise<Record<string, unknown>> {
  const relayed: string[] = [];
  const peers: Record<string, ReturnType<typeof createPeerConnection>> = {};

  /** Stands in for the control plane: hands a message to the other side. */
  const relay = (from: 'a' | 'b') => (type: string, payload: SignalMessage) => {
    relayed.push(`${from}:${type}`);
    const target = from === 'a' ? 'b' : 'a';
    void peers[target]?.accept(type, {
      ...payload,
      fromMembershipId: from === 'a' ? 'mem_aaa' : 'mem_bbb',
    });
  };

  let receivedTrackKind = '';
  peers.a = createPeerConnection({
    layupId: 'lay_harness01',
    localMembershipId: 'mem_aaa',
    remoteMembershipId: 'mem_bbb',
    sendSignal: relay('a'),
    createPeerConnection: (config) => new RTCPeerConnection(config),
    // Loopback inside one process: no STUN needed, and asking for it would
    // make the test depend on the internet.
    iceServers: [],
  });
  peers.b = createPeerConnection({
    layupId: 'lay_harness01',
    localMembershipId: 'mem_bbb',
    remoteMembershipId: 'mem_aaa',
    sendSignal: relay('b'),
    createPeerConnection: (config) => new RTCPeerConnection(config),
    iceServers: [],
    onTrack: (event) => {
      receivedTrackKind = event.track.kind;
    },
  });

  // A real, moving video track: a canvas capture stands in for screen capture.
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  const context = canvas.getContext('2d');
  let frame = 0;
  const draw = () => {
    if (!context) return;
    frame += 1;
    context.fillStyle = frame % 2 === 0 ? '#5b8def' : '#101216';
    context.fillRect(0, 0, canvas.width, canvas.height);
  };
  draw();
  const paint = setInterval(draw, 33);
  const stream = canvas.captureStream(30);
  for (const track of stream.getTracks()) peers.a.addTrack(track, stream);

  await peers.a.negotiate();

  const connected = await waitFor(
    () => peers.a.state().connected && peers.b.state().connected,
    'both peers to connect',
  );
  const gotTrack = await waitFor(() => receivedTrackKind === 'video', 'the video track to arrive');

  // Which route did ICE actually choose? Read through the production module.
  const diagnostics = await peers.a.diagnostics();

  clearInterval(paint);
  for (const track of stream.getTracks()) track.stop();
  peers.a.close('harness done');
  peers.b.close();

  return {
    connected,
    gotTrack,
    receivedTrackKind,
    route: diagnostics.route,
    relayed: diagnostics.relayed,
    localCandidateType: diagnostics.localCandidateType,
    remoteCandidateType: diagnostics.remoteCandidateType,
    rttMs: diagnostics.rttMs,
    bytesSent: diagnostics.bytesSent ?? 0,
    offers: relayed.filter((entry) => entry.endsWith(SIGNAL_OFFER)).length,
    answers: relayed.filter((entry) => entry.endsWith(SIGNAL_ANSWER)).length,
    candidates: relayed.filter((entry) => entry.endsWith(SIGNAL_CANDIDATE)).length,
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.error(`timed out waiting for ${label}`);
  return false;
}

/**
 * Forced relay with no TURN server reachable.
 *
 * This is the deterministic half of the TURN test mode: if `forceRelay` were
 * quietly ignored, these two peers would connect over host candidates exactly
 * like the run above. They must not. The other half - that a forced-relay
 * session *does* connect through a real TURN server - needs coturn, and is run
 * with the compose stack (see test/network/README.md).
 */
async function runForcedRelay(): Promise<Record<string, unknown>> {
  const peers: Record<string, ReturnType<typeof createPeerConnection>> = {};
  const relay = (from: 'a' | 'b') => (type: string, payload: SignalMessage) => {
    const target = from === 'a' ? 'b' : 'a';
    void peers[target]?.accept(type, payload);
  };

  const candidateTypes: string[] = [];
  for (const [id, remote] of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    peers[id] = createPeerConnection({
      layupId: 'lay_relayonly',
      localMembershipId: `mem_${id}`,
      remoteMembershipId: `mem_${remote}`,
      sendSignal: (type, payload) => {
        if (type === 'signal.candidate' && payload.candidate) {
          // "typ host" / "typ srflx" / "typ relay"
          const match = /typ (\w+)/.exec(payload.candidate);
          if (match?.[1]) candidateTypes.push(match[1]);
        }
        relay(id)(type, payload);
      },
      createPeerConnection: (config) => new RTCPeerConnection(config),
      // Relay forced, but no TURN server is configured or reachable.
      forceRelay: true,
      iceServers: [],
    });
  }

  peers.a!.createDataChannel('probe');
  await peers.a!.negotiate();

  // Give ICE a fair chance to do something it must not be able to do.
  const connected = await waitFor(() => peers.a!.state().connected, 'a connection', 4000);
  const config = (peers.a!.pc as RTCPeerConnection & { getConfiguration?: () => RTCConfiguration })
    .getConfiguration?.();

  peers.a!.close();
  peers.b!.close();

  return {
    iceTransportPolicy: config?.iceTransportPolicy ?? 'unset',
    connected,
    hostCandidatesGathered: candidateTypes.filter((type) => type === 'host').length,
    candidateTypes: [...new Set(candidateTypes)],
  };
}

/**
 * Screen publish and render, through the session module.
 *
 * Proves the whole shared-desktop path in real Chromium: one side publishes a
 * captured stream, the other receives it, and the frames actually decode into a
 * <video> element with real dimensions. A track that arrives but never decodes
 * is a black screen share, which is the failure this catches.
 */
async function runScreenShare(): Promise<Record<string, unknown>> {
  const sessions: Record<string, ReturnType<typeof createSession>> = {};
  const make = (id: 'a' | 'b', remote: 'a' | 'b') =>
    createSession({
      layupId: 'lay_screenshare',
      localMembershipId: `mem_${id}`,
      sendSignal: (type, payload) => {
        void sessions[remote]?.handleSignal(type, { ...payload, fromMembershipId: `mem_${id}` });
      },
      createRTCPeerConnection: (config) => new RTCPeerConnection(config),
      iceServers: [],
    });
  sessions.a = make('a', 'b');
  sessions.b = make('b', 'a');

  // Stand-in for desktop capture: a canvas that visibly changes every frame.
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext('2d');
  let frame = 0;
  const paint = setInterval(() => {
    if (!context) return;
    frame += 1;
    context.fillStyle = frame % 2 === 0 ? '#5b8def' : '#101216';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 33);
  const captured = canvas.captureStream(30);

  sessions.a.connect('mem_b', { initiate: true });
  sessions.a.publishScreen(captured);

  const received = await waitFor(
    () => Boolean(sessions.b?.remotes()[0]?.screen),
    'the shared desktop to arrive',
  );

  // Decode it for real.
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.srcObject = sessions.b.remotes()[0]?.screen ?? null;
  document.body.appendChild(video);
  await video.play().catch(() => undefined);
  const decoded = await waitFor(() => video.videoWidth > 0 && video.videoHeight > 0, 'frames to decode');

  const diagnostics = await sessions.b.diagnostics();
  const inbound = { width: video.videoWidth, height: video.videoHeight };

  // Stopping the share must not tear down the layup's connection.
  sessions.a.unpublishScreen();
  const stillConnected = sessions.a.remotes()[0]?.connection.connected === true;

  clearInterval(paint);
  for (const track of captured.getTracks()) track.stop();
  sessions.a.close();
  sessions.b.close();

  return {
    received,
    decoded,
    inbound,
    route: diagnostics.mem_a?.route ?? 'unknown',
    connectedAfterUnpublish: stillConnected,
  };
}

window.__layupWebRTC = (async () => ({
  direct: await run(),
  forcedRelayWithoutTurn: await runForcedRelay(),
  screenShare: await runScreenShare(),
}))();
