/**
 * A call, from the outside.
 *
 * This is the desktop's `useLayupRoom` with everything a guest has no business
 * with taken out, and it is deliberately assembled from the *same* modules -
 * `core/session`, `core/av`, `core/cursor-sender`, `core/cursor-receiver`,
 * `core/realtime-client`. A guest is a second client of the same call, not a
 * second implementation of one, so the negotiation, the coalescing and the
 * sequence gating are shared code rather than a browser-flavoured copy.
 *
 * What is missing is the point:
 *
 *   - **no screen sender.** A guest watches; nothing here ever captures a
 *     display, so no `RTCRtpSender` for a screen track is ever added;
 *   - **no annotation channel.** A guest does not draw, so `annotation-fast`
 *     is never opened - not opened-and-ignored;
 *   - **no input sender, and no grant is ever asked for or acted on.** Remote
 *     control is not something a link can buy. The presenter's machine refuses
 *     a guest outright (`core/input-guard.ts`), and this side does not try.
 *
 * The guest token authenticates the signalling socket as a query parameter,
 * exactly as the desktop's bearer token does (`realtimeUrl`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { envelope } from '@layup/protocol';
import { CHANNEL_CURSOR, CHANNEL_INPUT } from '@core/data-channels';
import { createAvController, type AvState } from '@core/av';
import { createCursorIdentityBook } from '@core/cursor-identity';
import { createCursorReceiver, type RemoteCursor } from '@core/cursor-receiver';
import { createCursorSender } from '@core/cursor-sender';
import { layupShape, type Layup } from '@core/control-client';
import { createRealtimeClient, type RealtimeSocket, type RealtimeStatus } from '@core/realtime-client';
import {
  SIGNAL_ANSWER,
  SIGNAL_BYE,
  SIGNAL_CANDIDATE,
  SIGNAL_OFFER,
  type SignalMessage,
} from '@core/peer-connection';
import { createSession, type RemoteMedia, type Session } from '@core/session';
import { leaveAsGuest, type GuestJoinResult } from './guest-client';

/** The realtime event carrying the layup to everybody in it. */
const TYPE_LAYUP_STATE = 'layup.state';

const SIGNAL_TYPES = [SIGNAL_OFFER, SIGNAL_ANSWER, SIGNAL_CANDIDATE, SIGNAL_BYE] as const;

/** Cursor and input. Never annotation: see the file comment. */
export const GUEST_CHANNELS = [CHANNEL_CURSOR, CHANNEL_INPUT] as const;

export interface GuestRoomState {
  /** The layup, kept current from `layup.state`. */
  layup: Layup;
  remotes: RemoteMedia[];
  /** The shared desktop, when somebody is presenting one. */
  screen?: MediaStream;
  presenterMembershipId?: string;
  /** This guest's own camera and microphone. */
  av: AvState;
  setCamera(enabled: boolean): void;
  setMicrophone(enabled: boolean): void;
  /** Interpolated cursors to draw, sampled per animation frame. */
  sampleCursors(): RemoteCursor[];
  /** Colour and label for a membership, stable for the life of the call. */
  identify(membershipId: string): { colour: string; label: string };
  /** Where this guest's pointer is over the shared surface, in its pixels. */
  moveCursor(input: { x: number; y: number; width: number; height: number }): void;
  connection: RealtimeStatus;
}

export interface UseGuestRoomOptions {
  /** The control plane's origin. */
  serverUrl: string;
  /** What redeeming the link gave us (`guest-client.ts`). */
  guest: GuestJoinResult;
  createRTCPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  socketFactory?: (url: string) => RealtimeSocket;
  /** Injectable for tests; defaults to the page's own fetch. */
  fetchImpl?: typeof fetch;
}

export function useGuestRoom(options: UseGuestRoomOptions): GuestRoomState {
  const { guest, serverUrl } = options;
  const membershipId = guest.membershipId;

  const [layup, setLayup] = useState<Layup>(guest.layup);
  const [remotes, setRemotes] = useState<RemoteMedia[]>([]);
  const [connection, setConnection] = useState<RealtimeStatus>('idle');
  const [av, setAv] = useState<AvState>({
    cameraEnabled: false,
    microphoneEnabled: false,
    muted: true,
  });

  // The injectable seams (peer-connection factory, getUserMedia, socket
  // factory) are held in a ref rather than named as effect dependencies. A
  // caller almost always passes fresh closures on every render, and a session
  // that tears itself down and rebuilds each time would take the call with it
  // - and `onChange` re-rendering us would make that a loop.
  const seams = useRef(options);
  seams.current = options;

  const sessionRef = useRef<Session | undefined>(undefined);
  const receiverRef = useRef(createCursorReceiver());
  const identityBook = useRef(createCursorIdentityBook({ selfMembershipId: membershipId }));
  const cursorSenderRef = useRef<ReturnType<typeof createCursorSender> | undefined>(undefined);
  const presenterRef = useRef<string | undefined>(undefined);
  const wiredPeers = useRef(new Set<string>());
  const avRef = useRef(
    createAvController({
      getUserMedia: (constraints) =>
        seams.current.getUserMedia?.(constraints) ?? navigator.mediaDevices.getUserMedia(constraints),
      onChange: (next) => setAv({ ...next }),
      onTrackReplaced: (track) => void sessionRef.current?.replaceCameraTrack(track),
    }),
  );

  const layupId = guest.layup.id;
  const participants = layup.participants;
  const presenterMembershipId = layup.activeShare?.presenterMembershipId;
  const sharedSourceId = layup.activeShare?.sourceId;

  /** Subscribes to a peer's channels once, when it first appears. */
  const wire = useCallback((peerMembershipId: string) => {
    const channels = sessionRef.current?.channels(peerMembershipId);
    if (!channels || wiredPeers.current.has(peerMembershipId)) return;
    wiredPeers.current.add(peerMembershipId);

    channels.on(CHANNEL_CURSOR, (message) => {
      try {
        receiverRef.current.apply(message as never);
      } catch {
        // A peer sending nonsense must not break the overlay for everyone.
      }
    });

    // `input-reliable` is opened but nothing is read from it and nothing is
    // ever sent on it. The presenter broadcasts control decisions there, and
    // for a guest every one of them is already a no: their machine refuses a
    // guest whatever it announced (`core/input-guard.ts`), so acting on one
    // here could only produce actions that are thrown away at the far end.
  }, []);

  // Signalling, and the layup as the control plane keeps describing it. The
  // guest token goes on the query string exactly as the desktop's bearer
  // token does - a browser WebSocket cannot set a header either.
  useEffect(() => {
    const realtime = createRealtimeClient({
      baseUrl: serverUrl,
      devUser: '',
      token: guest.guestToken,
      ...(seams.current.socketFactory ? { socketFactory: seams.current.socketFactory } : {}),
    });

    const cleanups: Array<() => void> = [
      realtime.onStatus((state) => setConnection(state.status)),
      realtime.on(TYPE_LAYUP_STATE, (message) => {
        try {
          const next = layupShape(message.payload, TYPE_LAYUP_STATE);
          if (next.id !== layupId) return;
          setLayup(next);
        } catch {
          // A payload we cannot read is dropped, never half-applied.
        }
      }),
      ...SIGNAL_TYPES.map((type) =>
        realtime.on(type, (message) => {
          void sessionRef.current?.handleSignal(type, message.payload as SignalMessage);
        }),
      ),
    ];

    const session = createSession({
      layupId,
      localMembershipId: membershipId,
      sendSignal: (type, message) => void realtime.send(envelope(type, message)),
      createRTCPeerConnection: (config) =>
        seams.current.createRTCPeerConnection?.(config) ?? new RTCPeerConnection(config),
      iceServers: seams.current.guest.iceServers,
      // Cursor and input only.
      channels: GUEST_CHANNELS,
      onChange: (next) => setRemotes([...next]),
    });
    sessionRef.current = session;
    session.setPresenter(presenterRef.current);

    cursorSenderRef.current = createCursorSender({
      membershipId,
      send: (move) => {
        let delivered = false;
        for (const remote of session.remotes()) {
          const sent = session.channels(remote.membershipId)?.send(CHANNEL_CURSOR, move) ?? false;
          delivered = sent || delivered;
        }
        return delivered;
      },
    });

    realtime.start();

    return () => {
      for (const cleanup of cleanups) cleanup();
      realtime.stop();
      cursorSenderRef.current?.stop();
      cursorSenderRef.current = undefined;
      wiredPeers.current.clear();
      session.close('leaving the call');
      sessionRef.current = undefined;
      setRemotes([]);
    };
    // The guest token and the layup are fixed for the life of this component:
    // a new one means a new redemption, and a new call.
  }, [layupId, membershipId, serverUrl, guest.guestToken]);

  /**
   * Closing the tab, said out loud.
   *
   * Two halves, and both matter: `signal.bye` so the peers tear their
   * connections down at once instead of waiting for ICE to give up, and
   * `POST /leave` so the *control plane* stops describing this guest as
   * somebody who is still in the room. Without the second one every desktop
   * keeps a tile that says "reconnecting…" for the rest of the call.
   *
   * `persisted` means the page is being frozen into the back/forward cache
   * rather than destroyed - they may be back in this same call in a second, so
   * that is a reconnect and not a departure.
   */
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      sessionRef.current?.close('leaving the call');
      leaveAsGuest({
        serverUrl,
        layupId,
        guestToken: guest.guestToken,
        ...(seams.current.fetchImpl ? { fetchImpl: seams.current.fetchImpl } : {}),
      });
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [layupId, serverUrl, guest.guestToken]);

  // Who is presenting decides how incoming video is classified (ADR-0007).
  useEffect(() => {
    presenterRef.current = presenterMembershipId;
    sessionRef.current?.setPresenter(presenterMembershipId);
  }, [presenterMembershipId]);

  // Connect to everybody else. Perfect negotiation settles who offers, so both
  // sides doing this is not a race.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    identityBook.current.sync(participants);
    for (const participant of participants) {
      if (participant.membershipId === membershipId || participant.leftAt) continue;
      session.connect(participant.membershipId);
      wire(participant.membershipId);
    }
    for (const gone of identityBook.current.retired()) {
      session.disconnect(gone, 'they left the call');
      wiredPeers.current.delete(gone);
      receiverRef.current.remove(gone);
    }
  }, [participants, membershipId, remotes.length, wire]);

  // Camera and microphone. A guest joins with both on: they were invited by
  // somebody who expects to see and hear them, and the toggles are right there.
  useEffect(() => {
    const controller = avRef.current;
    void controller.start(membershipId, { camera: true, microphone: true }).then((state) => {
      if (state.stream) sessionRef.current?.publishCamera(state.stream);
    });
    return () => {
      controller.stop();
    };
  }, [membershipId]);

  // A camera opened before the peer existed still has to reach it.
  useEffect(() => {
    const stream = avRef.current.state().stream;
    if (stream) sessionRef.current?.publishCamera(stream);
  }, [remotes.length]);

  const moveCursor = useCallback(
    (input: { x: number; y: number; width: number; height: number }) => {
      // Nothing is being shared, so there is no surface a position could mean
      // anything on.
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

  const screen = remotes.find((remote) => remote.screen)?.screen;

  return useMemo(
    () => ({
      layup,
      remotes,
      av,
      setCamera,
      setMicrophone,
      sampleCursors: () => receiverRef.current.sample(),
      identify: (id: string) => identityBook.current.identify(id),
      moveCursor,
      connection,
      ...(screen ? { screen } : {}),
      ...(presenterMembershipId ? { presenterMembershipId } : {}),
    }),
    [layup, remotes, av, setCamera, setMicrophone, moveCursor, connection, screen, presenterMembershipId],
  );
}
