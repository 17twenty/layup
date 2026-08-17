/**
 * The call, on a guest's screen.
 *
 * Deliberately smaller than the desktop's room, and smaller in ways a person
 * can see: there is no button that would share this guest's screen, nothing
 * to draw with, and nothing that offers control of anybody's machine. A guest
 * watches, talks, and points.
 *
 * Pointer positions leave here in the surface's own pixels together with its
 * size; normalising to 0..1 is `protocol/cursor.ts`'s job and is done in
 * exactly one place for every client, so a cursor lands where it was meant to
 * whatever size each end is displaying the video at.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { RemoteCursor } from '@core/cursor-receiver';
import type { GuestRoomState } from './useGuestRoom';

export interface GuestRoomProps {
  room: GuestRoomState;
  /** Injectable for tests; defaults to requestAnimationFrame. */
  scheduleFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export function GuestRoom({ room, scheduleFrame, cancelFrame }: GuestRoomProps) {
  const screenRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (screenRef.current) screenRef.current.srcObject = room.screen ?? null;
  }, [room.screen]);

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    room.moveCursor({
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      width: box.width,
      height: box.height,
    });
  }

  return (
    <main className="room">
      <header className="room__header">
        <h1>{room.layup.title ?? 'Layup'}</h1>
        <p className="room__connection" role="status">
          {room.connection === 'connected' ? 'Connected' : 'Connecting…'}
        </p>
      </header>

      <section className="screen" aria-label="Shared screen">
        {room.screen ? (
          // A layup with no shared screen is a perfectly valid layup, so the
          // two states are siblings rather than one being an error.
          <div className="screen__surface" data-testid="screen-surface" onPointerMove={onPointerMove}>
            <video
              ref={screenRef}
              className="screen__video"
              autoPlay
              muted
              playsInline
              data-testid="shared-screen"
              aria-label="The shared screen"
            />
            <Cursors
              sample={room.sampleCursors}
              identify={room.identify}
              {...(scheduleFrame ? { scheduleFrame } : {})}
              {...(cancelFrame ? { cancelFrame } : {})}
            />
          </div>
        ) : (
          <p className="screen__empty" data-testid="no-screen">
            Nobody is sharing a screen.
          </p>
        )}
      </section>

      <section className="room__faces" aria-label="People">
        {room.remotes.map((remote) => (
          <Face key={remote.membershipId} stream={remote.camera} label={room.identify(remote.membershipId).label} />
        ))}
      </section>

      <footer className="room__controls">
        <button type="button" onClick={() => room.setCamera(!room.av.cameraEnabled)}>
          {room.av.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
        </button>
        <button type="button" onClick={() => room.setMicrophone(!room.av.microphoneEnabled)}>
          {room.av.microphoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
        </button>
      </footer>
      {room.av.error ? <p role="alert">{room.av.error}</p> : null}
    </main>
  );
}

function Face({ stream, label }: { stream?: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null;
  }, [stream]);
  return (
    <figure className="face">
      <video ref={ref} autoPlay playsInline className="face__video" aria-label={label} />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/**
 * Synthetic cursors, drawn over the video at whatever size it happens to be.
 *
 * Redrawn per animation frame rather than per packet: a screen share stalling
 * at 8fps must not make the pointer stutter with it (SPEC.md §8.1). Nothing
 * here touches anybody's real cursor.
 */
function Cursors({
  sample,
  identify,
  scheduleFrame,
  cancelFrame,
}: {
  sample: () => RemoteCursor[];
  identify: (membershipId: string) => { colour: string; label: string };
  scheduleFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}) {
  const [cursors, setCursors] = useState<RemoteCursor[]>([]);

  useEffect(() => {
    const schedule = scheduleFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
    const cancel = cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
    let running = true;
    let handle = 0;
    const tick = () => {
      if (!running) return;
      // Nothing to draw and nothing was drawn: keep the same array, so an
      // idle overlay does not re-render the room sixty times a second.
      const next = sample();
      setCursors((previous) => (previous.length === 0 && next.length === 0 ? previous : next));
      handle = schedule(tick);
    };
    handle = schedule(tick);
    return () => {
      running = false;
      cancel(handle);
    };
  }, [sample, scheduleFrame, cancelFrame]);

  return (
    <div className="cursors" aria-hidden="true" data-testid="cursor-overlay">
      {cursors.map((cursor) => (
        <div
          key={cursor.membershipId}
          className="cursors__cursor"
          data-testid={`cursor-${cursor.membershipId}`}
          style={{
            position: 'absolute',
            left: `${cursor.x * 100}%`,
            top: `${cursor.y * 100}%`,
            color: identify(cursor.membershipId).colour,
          }}
        >
          {identify(cursor.membershipId).label}
        </div>
      ))}
    </div>
  );
}
