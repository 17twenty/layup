import { useMemo } from 'react';
import type { AssembledStroke } from '@layup/protocol';

/**
 * Annotations drawn over the shared screen.
 *
 * Strokes are SVG paths in a normalised 0..1 viewBox, so they scale with the
 * video without any resize handling and without ever touching the encoded
 * pixels: stopping the annotation leaves the screen share untouched, and the
 * presenter's encoder never sees a drawing (SPEC.md §9).
 */
export interface DrawingOverlayProps {
  strokes: AssembledStroke[];
  /** Colour per membership, so a stroke matches its author's cursor. */
  identify?: (membershipId: string) => { colour: string };
}

export function DrawingOverlay({ strokes, identify }: DrawingOverlayProps) {
  const paths = useMemo(
    () =>
      strokes
        .filter((stroke) => stroke.points.length > 0)
        .map((stroke) => ({
          id: stroke.strokeId,
          membershipId: stroke.membershipId,
          d: toPath(stroke),
          colour: identify?.(stroke.membershipId).colour ?? stroke.colour,
          width: stroke.width,
          hasGap: stroke.hasGap,
        })),
    [strokes, identify],
  );

  return (
    <svg
      className="drawing"
      data-testid="drawing-overlay"
      // A normalised canvas: the overlay scales with the video for free.
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {paths.map((path) => (
        <path
          key={path.id}
          data-testid={`stroke-${path.id}`}
          data-membership={path.membershipId}
          data-gap={path.hasGap ? 'true' : 'false'}
          d={path.d}
          fill="none"
          stroke={path.colour}
          strokeWidth={path.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/** A single point renders as a dot; anything longer renders as a polyline. */
function toPath(stroke: AssembledStroke): string {
  const [first, ...rest] = stroke.points;
  if (!first) return '';
  if (rest.length === 0) return `M ${first.x} ${first.y} l 0.0001 0`;
  return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(' ')}`;
}
