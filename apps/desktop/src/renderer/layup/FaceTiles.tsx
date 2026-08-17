import { useEffect, useRef } from 'react';
import type { AvState } from '../../core/av';
import type { RemoteMedia } from '../../core/session';

/**
 * The faces in a layup: yours and everybody else's.
 *
 * Small, always present, and deliberately not the main event - the shared
 * screen is what people are looking at. A layup with nobody sharing is still a
 * layup, so these carry on regardless of what the screen is doing (SPEC.md §7.1).
 *
 * Your own tile is mirrored, because a video of yourself that moves the wrong
 * way is unusable, and muted, because hearing yourself is unbearable.
 */
export interface FaceTilesProps {
  local: AvState;
  remotes: RemoteMedia[];
  /** Your own name, for your tile. */
  selfName?: string;
  /**
   * `stage` fills the window with faces and leaves the camera and microphone
   * to the call bar - the shape a call is, rather than a strip of thumbnails.
   * `compact` is the small strip used under a shared screen.
   */
  variant?: 'roomy' | 'compact' | 'stage';
  onToggleCamera: (enabled: boolean) => void;
  onToggleMicrophone: (enabled: boolean) => void;
}

export function FaceTiles({
  local,
  remotes,
  selfName,
  variant = 'roomy',
  onToggleCamera,
  onToggleMicrophone,
}: FaceTilesProps) {
  const withCamera = remotes.filter((remote) => remote.camera);
  const compact = variant !== 'roomy';
  const stage = variant === 'stage';

  const self = (
      <figure className="faces__tile faces__tile--self" data-testid="face-self">
        <Video stream={local.stream} mirrored muted />
        <figcaption>
          <span>{selfName ?? 'You'}</span>
          {stage ? null : (
            <>
              <button
                type="button"
                aria-pressed={local.cameraEnabled}
                onClick={() => onToggleCamera(!local.cameraEnabled)}
                data-testid="toggle-camera"
              >
                {local.cameraEnabled ? 'Camera on' : 'Camera off'}
              </button>
          <button
            type="button"
            aria-pressed={local.microphoneEnabled}
            onClick={() => onToggleMicrophone(!local.microphoneEnabled)}
            data-testid="toggle-microphone"
          >
            {local.microphoneEnabled ? 'Mic on' : 'Muted'}
          </button>
            </>
          )}
        </figcaption>
        {local.error ? (
          <p className="faces__error" data-testid="face-error">
            {local.error}
          </p>
        ) : null}
      </figure>
  );

  const others = withCamera.map((remote) => (
    <figure
      key={remote.membershipId}
      className="faces__tile"
      data-testid={`face-${remote.membershipId}`}
    >
      <Video stream={remote.camera} />
      <figcaption>
        <span>{remote.displayName ?? 'Someone'}</span>
        {!remote.connection.connected ? <span className="faces__state">reconnecting…</span> : null}
      </figcaption>
    </figure>
  ));

  return (
    <section
      className={stage ? 'faces faces--stage' : compact ? 'faces faces--compact' : 'faces'}
      aria-label="People in this layup"
    >
      {/* In the pill the other people come first: they are what you are here
          for, and your own face is the least interesting thing on screen. */}
      {compact ? (
        <>
          {others}
          {self}
        </>
      ) : (
        <>
          {self}
          {others}
        </>
      )}
    </section>
  );
}

function Video({
  stream,
  mirrored = false,
  muted = false,
}: {
  stream?: MediaStream;
  mirrored?: boolean;
  muted?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null;
  }, [stream]);

  return (
    <video
      ref={ref}
      className={mirrored ? 'faces__video faces__video--mirrored' : 'faces__video'}
      autoPlay
      playsInline
      muted={muted}
    />
  );
}
