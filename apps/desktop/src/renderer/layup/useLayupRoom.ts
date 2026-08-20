import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createStrokeAssembler,
  decodeInput,
  isControlMessage,
  type AssembledStroke,
  type ControlMessage,
} from '@layup/protocol';
import { createAnnotationGuard } from '../../core/annotation-guard';
import { CHANNEL_ANNOTATION, CHANNEL_CURSOR, CHANNEL_INPUT } from '../../core/data-channels';
import { createAvController, type AvState } from '../../core/av';
import { includesDevice, listDevices, NO_DEVICES, type DeviceList } from '../../core/devices';
import { createCursorIdentityBook } from '../../core/cursor-identity';
import { createCursorReceiver, type RemoteCursor } from '../../core/cursor-receiver';
import { createCursorSender } from '../../core/cursor-sender';
import { createInputSender, type InputSender } from '../../core/input-sender';
import { createSession, type RemoteMedia, type Session } from '../../core/session';
import type { RouteDiagnostics } from '../../core/ice-diagnostics';
import type { LayupStateResponse, ShareStateResponse } from '../../shared/ipc';

/** How often the route is re-read. Fast enough that "is it still relayed?"
 * has an answer within a couple of seconds, not so fast it costs anything. */
const DIAGNOSTICS_POLL_MS = 2000;

/**
 * The live half of a layup, in the renderer.
 *
 * This is where the peer connections are, because that is where Chromium is.
 * It carries three kinds of traffic and treats them very differently:
 *
 *   - **media**, straight between peers, never through the control plane;
 *   - **cursors**, sent and drawn here, because a synthetic cursor is an
 *     overlay and touches nobody's OS pointer;
 *   - **remote input**, which this side only ever *carries*. A message a peer
 *     sends is handed to the privileged process, which decides whether it
 *     becomes an OS event (ADR-0006). Nothing here can grant itself anything,
 *     and a grant we receive is a claim to act on *their* machine, not ours.
 */
export interface LayupRoom {
  remotes: RemoteMedia[];
  /** Your own camera and microphone. */
  av: AvState;
  setCamera(enabled: boolean): void;
  setMicrophone(enabled: boolean): void;
  /** The microphones, cameras and speakers this machine has. */
  devices: DeviceList;
  /** Re-reads the device list - worth doing whenever it is about to be shown. */
  refreshDevices(): void;
  /**
   * Changes which device is captured, mid-call. The new track is swapped into
   * the sender that is already there (`replaceTrack`), so no offer is created
   * and nothing on screen remounts. `undefined` means the system default.
   */
  setMicrophoneDevice(deviceId?: string): void;
  setCameraDevice(deviceId?: string): void;
  /** Chooses the output device. Applied to the media elements via setSinkId. */
  setSpeaker(deviceId?: string): void;
  /** Interpolated cursors to draw, sampled per animation frame. */
  sampleCursors: () => RemoteCursor[];
  /**
   * Strokes drawn over the shared screen by the people in the layup.
   *
   * Never by a guest: drawing from a guest membership is dropped as it
   * arrives (`core/annotation-guard.ts`), so nothing they send ever reaches
   * this list. The browser client not opening the channel is the polite half;
   * this is the half that holds when the client is modified.
   */
  strokes: AssembledStroke[];
  /** Colour and label for a membership, stable for the life of the layup. */
  identify(membershipId: string): { colour: string; label: string };
  /** Reports where our pointer is over the shared surface, normalised. */
  moveCursor(input: { x: number; y: number; width: number; height: number }): void;
  /** What the presenter has let us do, as they last told us. */
  scopes: string[];
  /** Sends remote input to the presenter, if we hold a grant. */
  input?: InputSender;
  /** What to aim actions at: the presenter's shared capture source. */
  targetDisplayId?: string;
  /**
   * Route, candidate types and RTT per peer, refreshed every
   * {@link DIAGNOSTICS_POLL_MS}. Empty until the first sample lands, and
   * again once the session is gone - the readout shows "Connecting…" for
   * that gap rather than stale numbers.
   */
  diagnostics: Record<string, RouteDiagnostics>;
}

export interface UseLayupRoomOptions {
  layup: LayupStateResponse | undefined;
  share: ShareStateResponse;
  /** The local screen being published, if this desktop is presenting. */
  localScreen?: MediaStream;
}

export function useLayupRoom({ layup, share, localScreen }: UseLayupRoomOptions): LayupRoom {
  const [remotes, setRemotes] = useState<RemoteMedia[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<Record<string, RouteDiagnostics>>({});
  const [av, setAv] = useState<AvState>({ cameraEnabled: false, microphoneEnabled: false, muted: true });
  const [devices, setDevices] = useState<DeviceList>(NO_DEVICES);
  const [strokes, setStrokes] = useState<AssembledStroke[]>([]);
  const sessionRef = useRef<Session | undefined>(undefined);
  const avRef = useRef(
    createAvController({
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      onChange: (next) => setAv({ ...next }),
      // A device change goes to the sender that is already publishing that
      // kind. Never a new track, never a new offer: a renegotiation mid-call
      // is what took the media elements - and the audio - down before.
      onTrackReplaced: (track) => void sessionRef.current?.replaceCameraTrack(track),
    }),
  );
  const receiverRef = useRef(createCursorReceiver());
  const cursorSenderRef = useRef<ReturnType<typeof createCursorSender> | undefined>(undefined);
  const inputSenderRef = useRef<InputSender | undefined>(undefined);
  const presenterRef = useRef<string | undefined>(undefined);
  const wiredPeers = useRef(new Set<string>());
  const identityBook = useRef(createCursorIdentityBook());
  const strokesRef = useRef(createStrokeAssembler());
  // Guest memberships, as the control plane last described them. Held in a ref
  // so the guard reads it live: a guest who arrives mid-call is a guest from
  // the moment the roster says so, without anything being rebuilt.
  const guestsRef = useRef(new Set<string>());
  const annotationGuard = useRef(
    createAnnotationGuard({ isGuestMembership: (id) => guestsRef.current.has(id) }),
  );

  const membershipId = layup?.membershipId;
  const layupId = layup?.layup?.id;
  const participants = layup?.layup?.participants;
  const presenterMembershipId = share.share?.presenterMembershipId;
  const sharedSourceId = share.share?.sourceId;

  /** Subscribes to a peer's channels once, when it first appears. */
  const wire = useCallback((peerMembershipId: string) => {
    const session = sessionRef.current;
    const channels = session?.channels(peerMembershipId);
    if (!channels || wiredPeers.current.has(peerMembershipId)) return;
    wiredPeers.current.add(peerMembershipId);

    channels.on(CHANNEL_CURSOR, (message) => {
      try {
        receiverRef.current.apply(message as never);
      } catch {
        // A peer sending nonsense must not break the overlay for everyone.
      }
    });

    // Drawing. Judged on arrival against the roster this machine was given,
    // never against what the message claims about itself - the sending client
    // is not what decides whether a guest draws (`core/annotation-guard.ts`).
    channels.on(CHANNEL_ANNOTATION, (message, channel) => {
      const decision = annotationGuard.current.accept(message, {
        membershipId: peerMembershipId,
        channel,
      });
      if (!decision.accepted) return;
      strokesRef.current.apply(decision.message);
      setStrokes(strokesRef.current.strokes());
    });

    channels.on(CHANNEL_INPUT, (message) => {
      let decoded;
      try {
        decoded = decodeInput(message);
      } catch {
        return;
      }
      if (isControlMessage(decoded)) {
        // A control decision from the presenter: what we may do on *their*
        // machine. Ours is unaffected.
        inputSenderRef.current?.applyControl(decoded as ControlMessage);
        setScopes(inputSenderRef.current?.scopes() ?? []);
        return;
      }
      // Somebody acting on this machine. Only the privileged process decides.
      void window.layup.input.offer(peerMembershipId, message as Record<string, unknown>);
    });
  }, []);

  useEffect(() => {
    if (!layupId || !membershipId) return;

    let cancelled = false;
    let session: Session | undefined;
    let diagnosticsTimer: ReturnType<typeof setInterval> | undefined;
    const cleanups: Array<() => void> = [];

    // ICE servers and the relay policy come from the control plane, so a
    // forced-relay policy applies before the first candidate is gathered.
    void window.layup.ice
      .config()
      .catch(() => ({ iceServers: [] as RTCIceServer[], forceRelay: false }))
      .then((config) => {
        if (cancelled) return;
        session = createSession({
          layupId,
          localMembershipId: membershipId,
          sendSignal: (type, message) => void window.layup.signal.send(type, message),
          createRTCPeerConnection: (rtcConfig) => new RTCPeerConnection(rtcConfig),
          iceServers: config.iceServers as RTCIceServer[],
          forceRelay: config.forceRelay,
          onChange: (next) => setRemotes([...next]),
        });
        sessionRef.current = session;
        session.setPresenter(presenterRef.current);

        // Route and RTT are read from live stats, not renegotiated - a relay
        // can appear or clear mid-call and nothing else would tell us. Only
        // starts once a session exists; there is nothing to poll before that.
        diagnosticsTimer = setInterval(() => {
          void session?.diagnostics().then((next) => {
            if (!cancelled) setDiagnostics(next);
          });
        }, DIAGNOSTICS_POLL_MS);

        cleanups.push(
          window.layup.signal.onReceived(({ type, message }) => {
            void session?.handleSignal(type, message);
          }),
        );

        // The privileged side hands us control decisions to deliver. We are the
        // postman: it wrote the message, and it will judge the replies.
        cleanups.push(
          window.layup.control.onSend((message) => {
            for (const remote of session?.remotes() ?? []) {
              session?.channels(remote.membershipId)?.send(CHANNEL_INPUT, message);
            }
          }),
        );

        inputSenderRef.current = createInputSender({
          membershipId,
          send: (message) => {
            const target = presenterRef.current;
            if (!target) return false;
            return session?.channels(target)?.send(CHANNEL_INPUT, message) ?? false;
          },
        });

        cursorSenderRef.current = createCursorSender({
          membershipId,
          send: (move) => {
            let delivered = false;
            for (const remote of session?.remotes() ?? []) {
              const sent = session?.channels(remote.membershipId)?.send(CHANNEL_CURSOR, move) ?? false;
              delivered = sent || delivered;
            }
            return delivered;
          },
        });
      });

    return () => {
      cancelled = true;
      if (diagnosticsTimer !== undefined) clearInterval(diagnosticsTimer);
      for (const cleanup of cleanups) cleanup();
      cursorSenderRef.current?.stop();
      cursorSenderRef.current = undefined;
      inputSenderRef.current = undefined;
      wiredPeers.current.clear();
      session?.close('leaving the layup');
      sessionRef.current = undefined;
      strokesRef.current.clear();
      setRemotes([]);
      setScopes([]);
      setDiagnostics({});
      setStrokes([]);
    };
  }, [layupId, membershipId]);

  // Who is presenting decides how incoming video is classified, and where our
  // own remote input is aimed (ADR-0007).
  useEffect(() => {
    presenterRef.current = presenterMembershipId;
    sessionRef.current?.setPresenter(presenterMembershipId);
  }, [presenterMembershipId]);

  // Connect to everybody else. Perfect negotiation settles who offers, so both
  // sides doing this is not a race.
  // Who is a guest, from every layup state update. This is the only place the
  // renderer can learn it - the data channels carry membership ids and nothing
  // else - and it is read live by the drawing guard.
  useEffect(() => {
    const guests = guestsRef.current;
    guests.clear();
    for (const participant of participants ?? []) {
      if (participant.isGuest) guests.add(participant.membershipId);
    }
  }, [participants]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !participants) return;
    identityBook.current.sync(participants);
    // The departed go first. Otherwise a membership the control plane has
    // marked as left is reconnected to on this very pass and closed again on
    // the next - which is what left a guest's tile "reconnecting…" for ever.
    for (const gone of identityBook.current.retired()) {
      session.disconnect(gone, 'they left the layup');
      wiredPeers.current.delete(gone);
      receiverRef.current.remove(gone);
      strokesRef.current.clear(gone);
      setStrokes(strokesRef.current.strokes());
    }
    for (const participant of participants) {
      if (participant.membershipId === membershipId) continue;
      // `leftAt` is the difference between somebody whose connection is
      // struggling and somebody who is not in the room any more. Only the
      // first is worth a connection; the second is a departure, and the tile
      // goes with them.
      if (participant.leftAt) continue;
      session.connect(participant.membershipId);
      wire(participant.membershipId);
    }
  }, [participants, membershipId, remotes.length, wire]);

  // Camera and microphone begin only once there is a membership, and the join
  // policy decides how they start - camera on, muted from the fifth person
  // (SPEC.md §4). Leaving releases the devices.
  const joinMedia = layup?.media;
  useEffect(() => {
    const controller = avRef.current;
    if (!membershipId) {
      controller.stop();
      return;
    }
    void controller
      .start(membershipId, {
        camera: joinMedia?.camera ?? true,
        microphone: joinMedia?.microphone ?? true,
      })
      .then((state) => {
        if (state.stream) sessionRef.current?.publishCamera(state.stream);
      });
    return () => {
      controller.stop();
    };
  }, [membershipId, joinMedia?.camera, joinMedia?.microphone]);

  // A camera opened before the peer existed still has to reach it.
  useEffect(() => {
    const stream = avRef.current.state().stream;
    if (stream) sessionRef.current?.publishCamera(stream);
  }, [remotes.length]);

  // Publish or withdraw the local screen as capture starts and stops.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (localScreen) session.publishScreen(localScreen);
    else session.unpublishScreen();
  }, [localScreen, remotes.length]);

  const refreshDevices = useCallback(async () => {
    const next = await listDevices();
    setDevices(next);
    return next;
  }, []);

  // Devices come and go mid-call - a headset is unplugged, a dock is pulled.
  // A chosen device that has gone would leave a dead track publishing silence,
  // so the default takes over instead.
  useEffect(() => {
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    void refreshDevices();
    if (!media?.addEventListener) return;

    const onDeviceChange = () => {
      void refreshDevices().then((next) => {
        const state = avRef.current.state();
        if (!includesDevice(next.microphones, state.microphoneId)) {
          void avRef.current.setMicrophoneDevice(undefined);
        }
        if (!includesDevice(next.cameras, state.cameraId)) {
          void avRef.current.setCameraDevice(undefined);
        }
        if (!includesDevice(next.speakers, state.speakerId)) avRef.current.setSpeaker(undefined);
      });
    };

    media.addEventListener('devicechange', onDeviceChange);
    return () => media.removeEventListener('devicechange', onDeviceChange);
  }, [refreshDevices]);

  const moveCursor = useCallback(
    (input: { x: number; y: number; width: number; height: number }) => {
      if (!sharedSourceId) return;
      cursorSenderRef.current?.move({ displayId: sharedSourceId, ...input });
    },
    [sharedSourceId],
  );

  const setCamera = useCallback((enabled: boolean) => void avRef.current.setCamera(enabled), []);
  const setMicrophone = useCallback(
    (enabled: boolean) => void avRef.current.setMicrophone(enabled),
    [],
  );
  const setMicrophoneDevice = useCallback(
    (deviceId?: string) => void avRef.current.setMicrophoneDevice(deviceId),
    [],
  );
  const setCameraDevice = useCallback(
    (deviceId?: string) => void avRef.current.setCameraDevice(deviceId),
    [],
  );
  const setSpeaker = useCallback((deviceId?: string) => void avRef.current.setSpeaker(deviceId), []);

  return useMemo(
    () => ({
      remotes,
      av,
      setCamera,
      setMicrophone,
      devices,
      refreshDevices: () => void refreshDevices(),
      setMicrophoneDevice,
      setCameraDevice,
      setSpeaker,
      sampleCursors: () => receiverRef.current.sample(),
      strokes,
      identify: (id: string) => identityBook.current.identify(id),
      moveCursor,
      scopes,
      diagnostics,
      ...(inputSenderRef.current ? { input: inputSenderRef.current } : {}),
      ...(sharedSourceId ? { targetDisplayId: sharedSourceId } : {}),
    }),
    [
      remotes,
      av,
      setCamera,
      setMicrophone,
      devices,
      refreshDevices,
      setMicrophoneDevice,
      setCameraDevice,
      setSpeaker,
      scopes,
      strokes,
      moveCursor,
      sharedSourceId,
      diagnostics,
    ],
  );
}
