import { useEffect, useRef, useState } from 'react';
import type { RemoteCursor } from '../../core/cursor-receiver';

/**
 * Synthetic cursors drawn over the shared screen.
 *
 * They are overlays, not OS pointers: nothing here moves anyone's real cursor
 * (SPEC.md §8.1). Positions are normalised, so they land correctly whatever
 * size the video is being displayed at, and the overlay ignores pointer events
 * so it never steals a click from the surface beneath it.
 */
export interface CursorOverlayProps {
  /** Samples the current interpolated cursors; called once per animation frame. */
  sample: () => RemoteCursor[];
  /** Colour and label per membership. */
  identify?: (membershipId: string) => { colour: string; label: string };
  /** Injectable for tests; defaults to requestAnimationFrame. */
  scheduleFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

const DEFAULT_IDENTITY = { colour: '#5b8def', label: '' };

export function CursorOverlay({ sample, identify, scheduleFrame, cancelFrame }: CursorOverlayProps) {
  const [cursors, setCursors] = useState<RemoteCursor[]>([]);
  const running = useRef(true);

  useEffect(() => {
    running.current = true;
    const schedule = scheduleFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
    const cancel = cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
    let handle = 0;

    // Cursors are redrawn per frame, independently of the video's frame rate:
    // a stalling screen share must not make the pointer stutter.
    const tick = () => {
      if (!running.current) return;
      setCursors(sample());
      handle = schedule(tick);
    };
    handle = schedule(tick);

    return () => {
      running.current = false;
      cancel(handle);
    };
  }, [sample, scheduleFrame, cancelFrame]);

  return (
    <div className="cursors" aria-hidden="true" data-testid="cursor-overlay">
      {cursors.map((cursor) => {
        const identity = identify?.(cursor.membershipId) ?? DEFAULT_IDENTITY;
        return (
          <div
            key={cursor.membershipId}
            className="cursors__cursor"
            data-testid={`cursor-${cursor.membershipId}`}
            data-x={cursor.x.toFixed(4)}
            data-y={cursor.y.toFixed(4)}
            style={{
              // Percentages, so the cursor tracks the video at any display size.
              left: `${cursor.x * 100}%`,
              top: `${cursor.y * 100}%`,
              color: identity.colour,
            }}
          >
            <svg viewBox="0 0 12 18" width="18" height="26" aria-hidden="true">
              <path d="M1 1 L1 15 L4.5 11.5 L7 17 L9.5 16 L7 10.5 L11 10.5 Z" fill="currentColor" stroke="#0b0d11" strokeWidth="1" />
            </svg>
            {identity.label && <span className="cursors__label">{identity.label}</span>}
          </div>
        );
      })}
    </div>
  );
}
