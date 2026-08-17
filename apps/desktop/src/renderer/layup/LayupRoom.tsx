import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LayupStateResponse,
  PermissionsResponse,
  RemoteControlStateResponse,
  ShareStateResponse,
} from '../../shared/ipc';
import { CapturePicker } from '../capture/CapturePicker';
import { useLocalCapture } from '../capture/useLocalCapture';
import { CompactBar } from '../shell/CompactBar';
import { nextMode } from '../shell/mode';
import { useWindowMode } from '../shell/useWindowMode';
import { CursorOverlay } from './CursorOverlay';
import { DrawingOverlay } from './DrawingOverlay';
import { RemoteControlIndicator } from './RemoteControlIndicator';
import { RemoteControlPanel } from './RemoteControlPanel';
import { SharedScreen } from './SharedScreen';
import { useLayupRoom } from './useLayupRoom';

/**
 * A layup, live: who is sharing, everybody's cursors, and - if the presenter
 * allows it - a way to actually use their machine.
 *
 * The asymmetry here is the whole design. On the presenter's side this shows
 * switches, a list of people and an unmistakable banner while anybody holds
 * control. On a viewer's side it shows the screen and, once they have been
 * given control, forwards their clicks and keys to the presenter - where they
 * are judged again before anything happens (ADR-0005, ADR-0006).
 *
 * There is one room and it is never taken down. The window's mode decides what
 * is laid over it - a screen to watch, a sheet to choose one - and never
 * whether the call exists, because the tiles underneath carry the audio.
 */
export interface LayupRoomProps {
  layup: LayupStateResponse;
  /** Leaves the layup. In the pill this is the only way out. */
  onLeave?: () => void;
}

const emptyShare: ShareStateResponse = {};
const emptyControl: RemoteControlStateResponse = {
  allowed: { pointer: false, keyboard: false },
  stopped: [],
  anyoneHasControl: false,
};

/** A stream's first video track, tolerating stand-ins that are not real
 * MediaStreams - tests carry `{}` where a stream would be. */
function firstVideoTrack(stream: MediaStream | undefined): MediaStreamTrack | undefined {
  return typeof stream?.getVideoTracks === 'function' ? stream.getVideoTracks()[0] : undefined;
}

export function LayupRoom({ layup, onLeave }: LayupRoomProps) {
  const [share, setShare] = useState<ShareStateResponse>(emptyShare);
  const [control, setControl] = useState<RemoteControlStateResponse>(emptyControl);
  const [error, setError] = useState<string | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);
  // Only Accessibility is read here, and only while presenting: it is the one
  // whose absence makes the switches below a lie.
  const [permissions, setPermissions] = useState<PermissionsResponse | undefined>();
  const capture = useLocalCapture();
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const membershipId = layup.membershipId;
  const presenting = Boolean(
    membershipId && share.share && share.share.presenterMembershipId === membershipId,
  );

  const room = useLayupRoom({
    layup,
    share,
    ...(capture.stream ? { localScreen: capture.stream } : {}),
  });

  useEffect(() => {
    void window.layup.share.current().then(setShare);
    void window.layup.control.sharing().then(setControl);
    const offShare = window.layup.share.onChanged(setShare);
    const offControl = window.layup.control.onChanged(setControl);
    return () => {
      offShare();
      offControl();
    };
  }, [layup.layup?.id]);

  useEffect(() => {
    // Asked when the switches are about to be shown, and again whenever this
    // machine starts presenting: a grant can be revoked between calls, and the
    // helper's answer is the only one that counts.
    if (!presenting) return;
    let cancelled = false;
    void window.layup.permissions
      .all()
      .then((next) => {
        if (!cancelled) setPermissions(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [presenting]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, []);

  const startSharing = useCallback(
    async (sourceId: string) => {
      const source = capture.sources.find((entry) => entry.id === sourceId);
      if (!source) {
        // Never silently. A click that does nothing and says nothing is
        // indistinguishable from a broken application, and was read as one.
        setError('That screen is no longer available. Refresh the list and choose it again.');
        return;
      }
      setPickerOpen(false);
      const started = await capture.start(source);
      if (!started.ok) {
        // A refused getUserMedia used to close the picker and announce a share
        // with no video in it - the layup was told somebody was presenting a
        // black rectangle. The refusal is almost always a permission, so it is
        // said out loud and nothing is announced.
        setError(started.reason);
        return;
      }
      await run(() => window.layup.share.start(sourceId));
    },
    [capture, run],
  );

  const stopSharing = useCallback(async () => {
    capture.stop();
    await run(() => window.layup.share.stop());
  }, [capture, run]);

  // Normalised position of an event over the shared surface: the sender never
  // deals in pixels, because it has no idea what the presenter's screen is.
  const positionOf = useCallback((event: { clientX: number; clientY: number }) => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0 || bounds.height === 0) return undefined;
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
      width: bounds.width,
      height: bounds.height,
    };
  }, []);

  const controlling = room.scopes.length > 0 && Boolean(room.targetDisplayId);

  const hasIncomingScreen = room.remotes.some((remote) => Boolean(remote.screen));

  // Small unless there is a reason: choosing a screen, or watching one.
  const mode = useWindowMode({ inLayup: true, pickerOpen, hasIncomingScreen });

  // What the picker is laid over. The room underneath is whatever it would be
  // with the picker shut, because the picker is a layer and never a
  // replacement: the faces below it are the call, and the remote ones are the
  // audio. Unmounting them to choose a window is how a screen picker came to
  // hang up on somebody.
  const base = nextMode({ inLayup: true, pickerOpen: false, hasIncomingScreen });

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const position = positionOf(event);
      if (!position) return;
      // Cursor movement is an overlay for everybody, always - it never moves
      // anybody's OS pointer (SPEC.md §8.1).
      room.moveCursor(position);
    },
    [positionOf, room],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      const position = positionOf(event);
      if (!position || !controlling || !room.input || !room.targetDisplayId) return;
      room.input.pointerDown({
        displayId: room.targetDisplayId,
        x: position.x,
        y: position.y,
        button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
      });
    },
    [positionOf, controlling, room],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const position = positionOf(event);
      if (!position || !controlling || !room.input || !room.targetDisplayId) return;
      room.input.pointerUp({
        displayId: room.targetDisplayId,
        x: position.x,
        y: position.y,
        button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
      });
    },
    [positionOf, controlling, room],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      const position = positionOf(event);
      if (!position || !controlling || !room.input || !room.targetDisplayId) return;
      room.input.pointerWheel({
        displayId: room.targetDisplayId,
        x: position.x,
        y: position.y,
        deltaX: Math.trunc(-event.deltaX / 20),
        deltaY: Math.trunc(-event.deltaY / 20),
      });
    },
    [positionOf, controlling, room],
  );

  // Keys go while the shared screen has focus and only then, so typing into
  // this application's own fields is never forwarded anywhere.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!room.scopes.includes('keyboard') || !room.input) return;
      event.preventDefault();
      room.input.keyDown(event.code);
    },
    [room],
  );

  const onKeyUp = useCallback(
    (event: React.KeyboardEvent) => {
      if (!room.scopes.includes('keyboard') || !room.input) return;
      event.preventDefault();
      room.input.keyUp(event.code);
    },
    [room],
  );

  const selfName = (layup.layup?.participants ?? []).find(
    (participant) => participant.membershipId === membershipId,
  )?.displayName;

  const others = (layup.layup?.participants ?? [])
    // Somebody who left is not in the room, and a person who left and came back
    // has two memberships - only the live one is them.
    .filter((participant) => !participant.leftAt && participant.membershipId !== membershipId)
    .map((participant) => ({
      membershipId: participant.membershipId,
      displayName: participant.displayName ?? 'Someone',
    }));

  // PLAN-1 is 1:1, so there is normally exactly one entry - keyed by the
  // other participant when known, falling back to whichever peer answered
  // rather than showing nothing while that lines up.
  const primaryDiagnostics =
    (others[0] && room.diagnostics[others[0].membershipId]) ?? Object.values(room.diagnostics)[0];

  // Whichever incoming video is actually on screen: the shared desktop when
  // there is one to watch, otherwise a camera - resolution and framerate
  // describe what the tester is looking at, not a track that never rendered.
  const incomingVideoTrack =
    room.remotes.map((remote) => firstVideoTrack(remote.screen)).find((track): track is MediaStreamTrack => Boolean(track)) ??
    room.remotes.map((remote) => firstVideoTrack(remote.camera)).find((track): track is MediaStreamTrack => Boolean(track));

  const errorLine = error ? (
    <p className="room__error" role="alert" data-testid="room-error">
      {error}
    </p>
  ) : null;

  const controlPanel = presenting ? (
    <RemoteControlPanel
      state={control}
      participants={others}
      onSetAllowed={(scope, allowed) => void run(() => window.layup.control.allow(scope, allowed))}
      onStop={(target) => void run(() => window.layup.control.stop(target))}
      onResume={(target) => void run(() => window.layup.control.resume(target))}
      {...(permissions ? { accessibility: permissions.accessibility } : {})}
      onOpenAccessibilitySettings={() =>
        void window.layup.permissions.openSettings('accessibility')
      }
    />
  ) : null;

  // One room, for the whole life of the layup. Every mode is something laid
  // over it - a screen to watch, a sheet to choose one - and none of them
  // replaces it, so the cameras and the microphones below never stop.
  return (
    <div className={`room room--${base}`} data-testid="room">
      <RemoteControlIndicator
        state={control}
        {...(control.shortcut ? { shortcut: control.shortcut } : {})}
        onStopAll={() => void run(() => window.layup.control.stopAll())}
      />

      {share.notice ? (
        <p className="room__notice" role="status" data-testid="share-notice">
          {share.notice.text}
        </p>
      ) : null}

      {/* Somebody's screen: the one thing worth a large window. It appears
          above the call and pushes nothing else out. */}
      {base === 'viewer' ? (
        <div
          ref={surfaceRef}
          className="room__surface"
          data-testid="room-surface"
          // Focusable so keystrokes can be forwarded only when the shared
          // screen is deliberately in focus.
          tabIndex={controlling ? 0 : -1}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onContextMenu={(event) => event.preventDefault()}
        >
          <SharedScreen
            remotes={room.remotes}
            {...(capture.stream ? { localScreen: capture.stream } : {})}
            {...(room.av.speakerId ? { speakerId: room.av.speakerId } : {})}
            overlay={
              <>
                {/* Strokes first, cursors over them: a pointer belongs on top
                    of what it drew. Nothing a guest sends is in either - both
                    are judged on arrival (core/annotation-guard.ts). */}
                <DrawingOverlay strokes={room.strokes} identify={room.identify} />
                <CursorOverlay sample={room.sampleCursors} identify={room.identify} />
              </>
            }
          />
        </div>
      ) : null}

      {/* The call: the faces, and the four things you do to a call. Mounted
          once, in one place, in every mode - a remote tile is unmuted, so it
          is the other person's voice as much as their face. */}
      <CompactBar
        local={room.av}
        remotes={room.remotes}
        {...(selfName ? { selfName } : {})}
        presenting={presenting}
        onToggleCamera={room.setCamera}
        onToggleMicrophone={room.setMicrophone}
        onShare={() => setPickerOpen(true)}
        onStopSharing={() => void stopSharing()}
        onLeave={() => onLeave?.()}
        {...(primaryDiagnostics ? { diagnostics: primaryDiagnostics } : {})}
        {...(incomingVideoTrack ? { diagnosticsVideoTrack: incomingVideoTrack } : {})}
        devices={room.devices}
        onSelectMicrophone={room.setMicrophoneDevice}
        onSelectCamera={room.setCameraDevice}
        onSelectSpeaker={room.setSpeaker}
        onOpenDevices={room.refreshDevices}
      />

      {base === 'viewer' ? (
        <div className="room__actions">
          {!presenting && share.share ? (
            // Only meaningful where taking the screen is refused; the server
            // says so plainly if it is not.
            <button
              type="button"
              onClick={() => void run(() => window.layup.share.ask())}
              data-testid="ask-to-share"
            >
              Ask to share
            </button>
          ) : null}
          {controlling ? (
            <span className="room__hint" data-testid="controlling-hint">
              You can use this screen ({room.scopes.join(' + ')}). Click it first, then type.
            </span>
          ) : null}
        </div>
      ) : null}

      {controlPanel}

      {/* Choosing a screen, over the top. The window grows for exactly as long
          as this is open; the call underneath carries on. */}
      {mode === 'picker' ? (
        <section className="room__overlay" aria-label="Choose a screen to share">
          <header className="room__sheet-header">
            <h2>Share a screen</h2>
            <button
              type="button"
              className="tile__action--secondary"
              onClick={() => setPickerOpen(false)}
              data-testid="cancel-picker"
            >
              Cancel
            </button>
          </header>
          {/* The room's capture, not a second one: the list drawn here is the
              same list a click is resolved against. */}
          <CapturePicker
            sources={capture.sources}
            refresh={capture.refresh}
            error={capture.error}
            onPicked={(source) => void startSharing(source.id)}
          />
          {/* The sheet covers the room, so the room's error line would be
              behind it. It belongs where the click that caused it was. */}
          {errorLine}
        </section>
      ) : null}

      {mode === 'picker' ? null : errorLine}
    </div>
  );
}
