/**
 * One 1:1 WebRTC peer connection.
 *
 * The control plane only relays signalling; media flows directly between the
 * two desktops, or over TURN when the network forces it (ARCHITECTURE.md §3.2).
 *
 * This module is framework-free and takes its RTCPeerConnection factory as an
 * argument, so the negotiation logic is testable without a browser and runs
 * unchanged in Electron.
 */
export const SIGNAL_OFFER = 'signal.offer';
export const SIGNAL_ANSWER = 'signal.answer';
export const SIGNAL_CANDIDATE = 'signal.candidate';
export const SIGNAL_BYE = 'signal.bye';

export interface SignalMessage {
  layupId: string;
  toMembershipId: string;
  fromMembershipId?: string;
  fromUserId?: string;
  sdp?: string;
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  reason?: string;
}

export type SignalSender = (type: string, payload: SignalMessage) => void;

export interface PeerConnectionOptions {
  layupId: string;
  /** This desktop's membership in the layup. */
  localMembershipId: string;
  /** The membership at the other end. */
  remoteMembershipId: string;
  /**
   * The impolite peer keeps its own offer in a glare; the polite peer rolls
   * back. Deriving it from the membership ids means both sides agree without
   * another round trip (perfect negotiation).
   */
  polite?: boolean;
  sendSignal: SignalSender;
  createPeerConnection: (config: RTCConfiguration) => RTCPeerConnection;
  iceServers?: RTCIceServer[];
  /** Forces relay-only candidates, for the TURN test mode. */
  forceRelay?: boolean;
  log?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  onTrack?: (event: RTCTrackEvent) => void;
  onStateChange?: (state: PeerState) => void;
  onDataChannel?: (channel: RTCDataChannel) => void;
}

export interface PeerState {
  connection: RTCPeerConnectionState;
  ice: RTCIceConnectionState;
  signalling: RTCSignalingState;
  /** True once media can flow. */
  connected: boolean;
  /** Set when the connection failed, for the UI to explain. */
  failure?: string;
}

export interface PeerConnection {
  readonly pc: RTCPeerConnection;
  state(): PeerState;
  /** Starts negotiation. Safe to call more than once. */
  negotiate(): Promise<void>;
  /** Handles one relayed signalling message. */
  accept(type: string, message: SignalMessage): Promise<void>;
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender;
  removeTrack(sender: RTCRtpSender): void;
  createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel;
  close(reason?: string): void;
}

const noopLog = { debug: () => {}, info: () => {}, warn: () => {} };

/** Default STUN configuration for PLAN-1 development. */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function createPeerConnection(options: PeerConnectionOptions): PeerConnection {
  const log = options.log ?? noopLog;
  // Deterministic and opposite on the two sides, with no extra negotiation.
  const polite = options.polite ?? options.localMembershipId < options.remoteMembershipId;

  const config: RTCConfiguration = {
    iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS,
    ...(options.forceRelay ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {}),
  };
  const pc = options.createPeerConnection(config);

  let makingOffer = false;
  let ignoreOffer = false;
  let closed = false;
  let failure: string | undefined;

  const state = (): PeerState => ({
    connection: pc.connectionState,
    ice: pc.iceConnectionState,
    signalling: pc.signalingState,
    connected: pc.connectionState === 'connected',
    ...(failure ? { failure } : {}),
  });

  const publish = () => options.onStateChange?.(state());

  const send = (type: string, extra: Partial<SignalMessage>) =>
    options.sendSignal(type, {
      layupId: options.layupId,
      toMembershipId: options.remoteMembershipId,
      ...extra,
    });

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    send(SIGNAL_CANDIDATE, {
      candidate: event.candidate.candidate,
      ...(event.candidate.sdpMid ? { sdpMid: event.candidate.sdpMid } : {}),
      ...(event.candidate.sdpMLineIndex === null
        ? {}
        : { sdpMLineIndex: event.candidate.sdpMLineIndex }),
    });
  };

  pc.onnegotiationneeded = () => {
    void (async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) send(SIGNAL_OFFER, { sdp: pc.localDescription.sdp });
      } catch (error) {
        log.warn('negotiation failed', { reason: describe(error) });
      } finally {
        makingOffer = false;
      }
    })();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      failure = 'the peer connection failed - the network may be blocking direct and relay paths';
      log.warn('peer connection failed', { layupId: options.layupId });
    }
    if (pc.connectionState === 'connected') failure = undefined;
    log.debug('peer connection state', { state: pc.connectionState });
    publish();
  };

  pc.oniceconnectionstatechange = () => publish();
  if (options.onTrack) pc.ontrack = options.onTrack;
  if (options.onDataChannel) {
    pc.ondatachannel = (event) => options.onDataChannel?.(event.channel);
  }

  return {
    pc,
    state,

    async negotiate() {
      if (closed) return;
      makingOffer = true;
      try {
        await pc.setLocalDescription();
        if (pc.localDescription) send(SIGNAL_OFFER, { sdp: pc.localDescription.sdp });
      } finally {
        makingOffer = false;
      }
    },

    async accept(type, message) {
      if (closed) return;
      switch (type) {
        case SIGNAL_OFFER:
        case SIGNAL_ANSWER: {
          if (!message.sdp) return;
          const description = {
            type: type === SIGNAL_OFFER ? 'offer' : 'answer',
            sdp: message.sdp,
          } as RTCSessionDescriptionInit;

          // Perfect negotiation: in a glare the impolite peer ignores the
          // incoming offer, the polite peer rolls its own back.
          const offerCollision =
            description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) {
            log.debug('ignored a colliding offer', { polite });
            return;
          }

          await pc.setRemoteDescription(description);
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            if (pc.localDescription) send(SIGNAL_ANSWER, { sdp: pc.localDescription.sdp });
          }
          return;
        }

        case SIGNAL_CANDIDATE: {
          if (!message.candidate) return;
          try {
            await pc.addIceCandidate({
              candidate: message.candidate,
              ...(message.sdpMid === undefined ? {} : { sdpMid: message.sdpMid }),
              ...(message.sdpMLineIndex === undefined
                ? {}
                : { sdpMLineIndex: message.sdpMLineIndex }),
            });
          } catch (error) {
            // A candidate that arrives while we ignored an offer is expected.
            if (!ignoreOffer) log.warn('could not add a candidate', { reason: describe(error) });
          }
          return;
        }

        case SIGNAL_BYE: {
          failure = message.reason || 'the other side hung up';
          this.close(failure);
          return;
        }

        default:
          log.warn('unknown signalling message', { type });
      }
    },

    addTrack: (track, stream) => pc.addTrack(track, stream),
    removeTrack: (sender) => pc.removeTrack(sender),
    createDataChannel: (label, init) => pc.createDataChannel(label, init),

    close(reason) {
      if (closed) return;
      closed = true;
      if (reason && reason !== failure) send(SIGNAL_BYE, { reason });
      pc.close();
      log.info('peer connection closed', { reason: reason ?? 'local' });
      publish();
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
