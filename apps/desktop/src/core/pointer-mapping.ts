/**
 * Normalised surface coordinates to presenter screen pixels.
 *
 * A remote click arrives as a fraction of the shared surface, because the
 * sender has no idea what the presenter's screens look like (SPEC.md §8.1).
 * Turning that back into a pixel is the presenter's job, and it is the step
 * where a wrong assumption puts a click somewhere nobody asked for - a display
 * placed to the left of the primary one has a negative origin, and a display
 * scaled at 2x reports its bounds in logical points, not physical pixels.
 *
 * So this is deliberately small, pure and tested on its own.
 */

/** A display as the OS describes it, in its own coordinate space. */
export interface DisplayBounds {
  /** Matches the `displayId` carried by cursor and input messages. */
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Maps a normalised position on a display to a point in the OS's coordinate
 * space. Returns undefined when the display is unknown or has no area, rather
 * than clicking somewhere arbitrary.
 */
export function toScreenPoint(
  position: { displayId: string; x: number; y: number },
  displays: DisplayBounds[],
): ScreenPoint | undefined {
  const display = displays.find((entry) => entry.displayId === position.displayId);
  if (!display || display.width <= 0 || display.height <= 0) return undefined;

  // Clamp rather than refuse: a point a hair outside the surface, from rounding
  // at the sender's end, should land on the edge, not be thrown away.
  const fractionX = clamp01(position.x);
  const fractionY = clamp01(position.y);

  return {
    // width - 1 so 1.0 is the last pixel of this display rather than the first
    // pixel of the next one along.
    x: display.x + Math.round(fractionX * (display.width - 1)),
    y: display.y + Math.round(fractionY * (display.height - 1)),
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
