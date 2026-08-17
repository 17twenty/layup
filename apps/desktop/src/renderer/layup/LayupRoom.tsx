import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LayupStateResponse,
  RemoteControlStateResponse,
  ShareStateResponse,
} from '../../shared/ipc';
import { CapturePicker } from '../capture/CapturePicker';
import { useLocalCapture } from '../capture/useLocalCapture';
import { CompactBar } from '../shell/CompactBar';
import { useWindowMode } from '../shell/useWindowMode';
import { CursorOverlay } from './CursorOverlay';
import { FaceTiles } from './FaceTiles';
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

export function LayupRoom({ layup, onLeave }: LayupRoomProps) {
  const [share, setShare] = useState<ShareStateResponse>(emptyShare);
  const [control, setControl] = useState<RemoteControlStateResponse>(emptyControl);
  const [error, setError] = useState<string | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);
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
      if (!source) return;
      setPickerOpen(false);
      await capture.start(source);
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

  // Small unless there is a reason: choosing a screen, or watching one.
  const mode = useWindowMode({
    inLayup: true,
    pickerOpen,
    hasIncomingScreen: room.remotes.some((remote) => Boolean(remote.screen)),
  });

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

  const errorLine = error ? (
    <p className="room__error" role="alert" data-testid="room-error">
      {error}
    </p>
  ) : null;

  // Choosing a screen. The window grows for exactly as long as this is open.
  if (mode === 'picker') {
    return (
      <section className="room room--picker" aria-label="Choose a screen to share">
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
        <CapturePicker onPicked={(source) => void startSharing(source.id)} />
        {errorLine}
      </section>
    );
  }

  // Nobody's screen to look at: the pill, and nothing else.
  if (mode === 'compact') {
    return (
      <>
        {/* The presenter is the one who needs to know, and the presenter is
            the one in the pill. */}
        <RemoteControlIndicator
          state={control}
          {...(control.shortcut ? { shortcut: control.shortcut } : {})}
          onStopAll={() => void run(() => window.layup.control.stopAll())}
        />
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
        />
        {presenting ? (
          <RemoteControlPanel
            state={control}
            participants={others}
            onSetAllowed={(scope, allowed) => void run(() => window.layup.control.allow(scope, allowed))}
            onStop={(target) => void run(() => window.layup.control.stop(target))}
            onResume={(target) => void run(() => window.layup.control.resume(target))}
          />
        ) : null}
        {share.notice ? (
          <p className="room__notice" role="status" data-testid="share-notice">
            {share.notice.text}
          </p>
        ) : null}
        {errorLine}
      </>
    );
  }

  // Watching somebody's screen: the one thing worth a large window.
  return (
    <section className="room" aria-label="Layup">
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

      <div
        ref={surfaceRef}
        className="room__surface"
        data-testid="room-surface"
        // Focusable so keystrokes can be forwarded only when the shared screen
        // is deliberately in focus.
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
          overlay={<CursorOverlay sample={room.sampleCursors} identify={room.identify} />}
        />
      </div>

      <div className="room__actions">
        <FaceTiles
          variant="compact"
          local={room.av}
          remotes={room.remotes}
          {...(selfName ? { selfName } : {})}
          onToggleCamera={room.setCamera}
          onToggleMicrophone={room.setMicrophone}
        />
        {presenting ? (
          <button type="button" onClick={() => void stopSharing()} data-testid="stop-sharing">
            Stop sharing
          </button>
        ) : (
          <>
            <button type="button" onClick={() => setPickerOpen(true)} data-testid="share-screen">
              Share a screen
            </button>
            {share.share ? (
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
          </>
        )}
        {controlling ? (
          <span className="room__hint" data-testid="controlling-hint">
            You can use this screen ({room.scopes.join(' + ')}). Click it first, then type.
          </span>
        ) : null}
      </div>

      {presenting ? (
        <RemoteControlPanel
          state={control}
          participants={others}
          onSetAllowed={(scope, allowed) => void run(() => window.layup.control.allow(scope, allowed))}
          onStop={(target) => void run(() => window.layup.control.stop(target))}
          onResume={(target) => void run(() => window.layup.control.resume(target))}
        />
      ) : null}

      {errorLine}
    </section>
  );
}
