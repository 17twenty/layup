import { useEffect, useRef } from 'react';
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
}

export function SharedScreen({ remotes, localScreen }: SharedScreenProps) {
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
            : 'Nobody is sharing a screen. Audio and video carry on regardless.'}
        </p>
      </section>
    );
  }

  return (
    <section className="screen" aria-label="Shared screen">
      <video
        ref={videoRef}
        className="screen__video"
        autoPlay
        muted
        playsInline
        data-testid="shared-screen"
        aria-label={`${presenter.displayName ?? 'Someone'}'s screen`}
      />
      <p className="screen__caption">
        {presenter.displayName ?? 'Someone'} is sharing
        {presenter.connection.connected ? '' : ' · reconnecting…'}
      </p>
    </section>
  );
}
