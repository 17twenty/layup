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

  // Which route did ICE actually choose?
  const stats = await peers.a.pc.getStats();
  let route = 'unknown';
  let bytesSent = 0;
  stats.forEach((report: { type: string; state?: string; localCandidateId?: string; bytesSent?: number }) => {
    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
      route = 'succeeded';
      bytesSent = report.bytesSent ?? 0;
    }
  });
  stats.forEach((report: { type: string; candidateType?: string }) => {
    if (report.type === 'local-candidate' && report.candidateType) {
      route = `${route}:${report.candidateType}`;
    }
  });

  clearInterval(paint);
  for (const track of stream.getTracks()) track.stop();
  peers.a.close('harness done');
  peers.b.close();

  return {
    connected,
    gotTrack,
    receivedTrackKind,
    route,
    bytesSent,
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

window.__layupWebRTC = run();
