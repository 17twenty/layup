/**
 * One layup's media session, as seen by this desktop.
 *
 * It owns the peer connections for the layup and what is published on them.
 * It lives in the renderer because RTCPeerConnection is a DOM API, and it is
 * framework-free so the rules are testable without React.
 *
 * PLAN-1 is 1:1, so there is normally exactly one peer, but nothing here
 * assumes that: business semantics must not depend on media topology
 * (ARCHITECTURE.md §3.3).
 */
import {
  SIGNAL_ANSWER,
  SIGNAL_BYE,
  SIGNAL_CANDIDATE,
  SIGNAL_OFFER,
  createPeerConnection,
  type PeerConnection,
  type PeerState,
  type SignalMessage,
} from './peer-connection';
import type { RouteDiagnostics } from './ice-diagnostics';
import { createDataChannels, type DataChannelSet } from './data-channels';

/** Everything a peer publishes to us, or we publish to them. */
export interface RemoteMedia {
  membershipId: string;
  userId?: string;
  displayName?: string;
  /** The shared desktop, when that peer is the layup's active presenter. */
  screen?: MediaStream;
  /** Camera and microphone from that peer. */
  camera?: MediaStream;
  connection: PeerState;
}

export interface SessionPeer {
  membershipId: string;
  peer: PeerConnection;
  media: RemoteMedia;
  /** cursor-fast / annotation-fast / input-reliable for this peer (ADR-0008). */
  channels: DataChannelSet;
}

export interface SessionOptions {
  layupId: string;
  localMembershipId: string;
  sendSignal: (type: string, payload: SignalMessage) => void;
  createRTCPeerConnection: (config: RTCConfiguration) => RTCPeerConnection;
  iceServers?: RTCIceServer[];
  forceRelay?: boolean;
  onChange?: (peers: RemoteMedia[]) => void;
  log?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface Session {
  /** Opens a connection to a membership, or returns the existing one. */
  connect(membershipId: string, options?: { initiate?: boolean }): SessionPeer;
  /** Routes one relayed signalling message to the right peer. */
  handleSignal(type: string, message: SignalMessage): Promise<void>;
  /** Publishes the local screen to every peer. Replaces any previous share. */
  publishScreen(stream: MediaStream): void;
  /** Publishes camera and microphone to every peer. */
  publishCamera(stream: MediaStream): void;
  /**
   * Swaps one published camera or microphone track for another, in place.
   *
   * This is how changing a device works: the sender already publishing that
   * kind takes the new track, so the transceiver, the m-line and the SDP are
   * all untouched and nothing renegotiates.
   */
  replaceCameraTrack(track: MediaStreamTrack): Promise<void>;
  /**
   * Who the control plane says is presenting. Incoming video is classified as
   * the shared desktop only for that membership, so the domain decides what a
   * screen is - not a guess about track order (ADR-0007).
   */
  setPresenter(membershipId: string | undefined): void;
  /** Stops publishing the local screen. The layup itself is unaffected. */
  unpublishScreen(): void;
  /** What each peer is sending us. */
  remotes(): RemoteMedia[];
  /** The stream this desktop is publishing, if any. */
  localScreen(): MediaStream | undefined;
  diagnostics(): Promise<Record<string, RouteDiagnostics>>;
  /** The data channels for one peer, if connected. */
  channels(membershipId: string): DataChannelSet | undefined;
  /** Closes one peer, e.g. when they leave the layup. */
  disconnect(membershipId: string, reason?: string): void;
  close(reason?: string): void;
}

const noopLog = { debug: () => {}, info: () => {}, warn: () => {} };

export function createSession(options: SessionOptions): Session {
  const log = options.log ?? noopLog;
  const peers = new Map<string, SessionPeer>();
  // One sender per peer, so re-sharing replaces the track instead of adding a
  // second one - exactly one shared desktop exists per layup (ADR-0007).
  const screenSenders = new Map<string, RTCRtpSender>();
  // Kept with the kind they were created for: a sender's own `track` is null
  // while it is being swapped, and matching by index breaks the moment the
  // stream's track order changes under a device switch.
  const cameraSenders = new Map<string, Array<{ kind: string; sender: RTCRtpSender }>>();
  let localScreen: MediaStream | undefined;
  let localCamera: MediaStream | undefined;
  let presenterMembershipId: string | undefined;

  const publish = () => options.onChange?.(remotes());
  const remotes = () => [...peers.values()].map((entry) => entry.media);

  function connect(membershipId: string, connectOptions: { initiate?: boolean } = {}): SessionPeer {
    const existing = peers.get(membershipId);
    if (existing) return existing;

    const media: RemoteMedia = {
      membershipId,
      connection: { connection: 'new', ice: 'new', signalling: 'stable', connected: false },
    };

    const peer = createPeerConnection({
      layupId: options.layupId,
      localMembershipId: options.localMembershipId,
      remoteMembershipId: membershipId,
      sendSignal: options.sendSignal,
      createPeerConnection: options.createRTCPeerConnection,
      ...(options.iceServers ? { iceServers: options.iceServers } : {}),
      ...(options.forceRelay ? { forceRelay: true } : {}),
      log,
      onTrack: (event) => {
        const [stream] = event.streams;
        if (stream) {
          // The domain decides what counts as the shared desktop.
          if (event.track.kind === 'video' && presenterMembershipId === membershipId) {
            media.screen = stream;
          } else {
            media.camera = stream;
          }
        }
        event.track.addEventListener('ended', () => {
          if (media.screen === stream) media.screen = undefined;
          // The camera stream carries two tracks; it is only gone once both have ended.
          if (stream && media.camera === stream && stream.getTracks().every((t) => t.readyState === 'ended')) {
            media.camera = undefined;
          }
          publish();
        });
        log.info('remote track received', { membershipId, kind: event.track.kind });
        publish();
      },
      onStateChange: (state) => {
        media.connection = state;
        publish();
      },
    });

    // The three semantic channels are negotiated up front, so both sides have
    // them the moment the connection opens.
    const channels = createDataChannels({
      createDataChannel: (label, init) => peer.createDataChannel(label, init),
      log,
    });

    const entry: SessionPeer = { membershipId, peer, media, channels };
    peers.set(membershipId, entry);

    // Whoever is already publishing keeps publishing to a peer that arrives later.
    if (localScreen) attachScreen(entry, localScreen);
    if (localCamera) attachCamera(entry, localCamera);
    if (connectOptions.initiate) void peer.negotiate();

    publish();
    return entry;
  }

  function attachScreen(entry: SessionPeer, stream: MediaStream) {
    const [track] = stream.getVideoTracks();
    if (!track) return;
    const sender = screenSenders.get(entry.membershipId);
    if (sender) {
      // Replacing the track keeps the same m-line and avoids renegotiation.
      void sender.replaceTrack(track);
      return;
    }
    screenSenders.set(entry.membershipId, entry.peer.addTrack(track, stream));
  }

  function attachCamera(entry: SessionPeer, stream: MediaStream) {
    const existing = cameraSenders.get(entry.membershipId);
    if (existing) {
      // Replace in place, matched by kind: swapping devices must not
      // renegotiate, and audio must never land in the video sender.
      for (const track of stream.getTracks()) {
        const held = existing.find((entry) => entry.kind === track.kind);
        if (held && held.sender.track !== track) void held.sender.replaceTrack(track);
      }
      return;
    }
    cameraSenders.set(
      entry.membershipId,
      stream.getTracks().map((track) => ({ kind: track.kind, sender: entry.peer.addTrack(track, stream) })),
    );
  }

  return {
    connect,
    remotes,
    localScreen: () => localScreen,

    channels: (membershipId) => peers.get(membershipId)?.channels,

    setPresenter(membershipId) {
      presenterMembershipId = membershipId;
    },

    publishCamera(stream) {
      localCamera = stream;
      for (const entry of peers.values()) attachCamera(entry, stream);
      log.info('publishing camera and microphone', { peers: peers.size });
      publish();
    },

    async replaceCameraTrack(track) {
      // Only the sender already carrying this kind, and only replaceTrack.
      // Adding one would fire negotiationneeded, and a renegotiation mid-call
      // is what took the media elements - and the audio - down before.
      const swaps: Array<Promise<void>> = [];
      for (const [membershipId, held] of cameraSenders) {
        const target = held.find((entry) => entry.kind === track.kind);
        if (!target) continue;
        swaps.push(target.sender.replaceTrack(track));
        log.debug('swapped a capture track in place', { membershipId, kind: track.kind });
      }
      await Promise.all(swaps);
      log.info('capture device changed without renegotiating', { kind: track.kind });
    },

    async handleSignal(type, message) {
      const from = message.fromMembershipId;
      if (!from || message.layupId !== options.layupId) return;
      // An offer from someone we have not met yet opens the connection: the
      // callee never initiates, so a glare needs no extra rule here.
      const entry = peers.get(from) ?? connect(from);
      await entry.peer.accept(type, message);
      if (type === SIGNAL_BYE) peers.delete(from);
    },

    publishScreen(stream) {
      localScreen = stream;
      for (const entry of peers.values()) attachScreen(entry, stream);
      log.info('publishing shared desktop', { peers: peers.size });
      publish();
    },

    unpublishScreen() {
      localScreen = undefined;
      for (const [membershipId, sender] of screenSenders) {
        // Null keeps the transceiver in place, so re-sharing does not have to
        // renegotiate from scratch.
        void sender.replaceTrack(null);
        log.debug('stopped publishing to peer', { membershipId });
      }
      log.info('stopped sharing the desktop');
      publish();
    },

    async diagnostics() {
      const out: Record<string, RouteDiagnostics> = {};
      for (const [membershipId, entry] of peers) {
        out[membershipId] = await entry.peer.diagnostics();
      }
      return out;
    },

    disconnect(membershipId, reason) {
      const entry = peers.get(membershipId);
      if (!entry) return;
      entry.channels.close();
      entry.peer.close(reason ?? 'they left the layup');
      peers.delete(membershipId);
      screenSenders.delete(membershipId);
      cameraSenders.delete(membershipId);
      publish();
    },

    close(reason) {
      for (const [membershipId, entry] of peers) {
        entry.channels.close();
        entry.peer.close(reason ?? 'leaving the layup');
        screenSenders.delete(membershipId);
        cameraSenders.delete(membershipId);
      }
      peers.clear();
      localScreen = undefined;
      publish();
    },
  };
}

export const SIGNAL_TYPES = [SIGNAL_OFFER, SIGNAL_ANSWER, SIGNAL_CANDIDATE, SIGNAL_BYE] as const;
