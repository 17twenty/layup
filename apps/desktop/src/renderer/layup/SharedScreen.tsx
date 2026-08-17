import { useEffect, useRef, type ReactNode } from 'react';
import type { RemoteMedia } from '../../core/session';

/**
 * The shared desktop, as received from a peer.
 *
 * A layup with no shared screen is a perfectly valid layup, so "nobody is
 * sharing" is a normal state with a plain explanation rather than an error
 * (SPEC.md §7.1).
 */
export interface SharedScreenProps {
  remotes: RemoteMedia[];
  /** What this desktop is publishing, if anything. */
  localScreen?: MediaStream;
  /** Cursor overlay, drawn over the video at its rendered size. */
  overlay?: ReactNode;
}

export function SharedScreen({ remotes, localScreen, overlay }: SharedScreenProps) {
  const presenter = remotes.find((remote) => remote.screen);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = presenter?.screen ?? null;
  }, [presenter?.screen]);

  if (!presenter) {
    return (
      <section className="screen" aria-label="Shared screen">
        <p className="screen__empty" data-testid="no-screen">
          {localScreen
            ? 'You are sharing your screen.'
            : 'Nobody is sharing a screen.'}
        </p>
      </section>
    );
  }

  return (
    <section className="screen" aria-label="Shared screen">
      <div className="screen__surface">
        <video
          ref={videoRef}
          className="screen__video"
          autoPlay
          muted
          playsInline
          data-testid="shared-screen"
          aria-label={`${presenter.displayName ?? 'Someone'}'s screen`}
        />
        {/* Positioned over the video, so normalised cursors land correctly at
            whatever size it is being displayed. */}
        {overlay}
      </div>
      <p className="screen__caption">
        {presenter.displayName ?? 'Someone'} is sharing
        {presenter.connection.connected ? '' : ' · reconnecting…'}
      </p>
    </section>
  );
}
