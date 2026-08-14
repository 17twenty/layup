import { describe, expect, it } from 'vitest';
import { toScreenPoint, type DisplayBounds } from './pointer-mapping';

const primary: DisplayBounds = { displayId: 'd-1', x: 0, y: 0, width: 1920, height: 1080 };
// Placed to the left of the primary display, so its origin is negative.
const secondary: DisplayBounds = { displayId: 'd-2', x: -2560, y: -200, width: 2560, height: 1440 };

describe('normalised position to screen pixel', () => {
  it('lands a click where the sender aimed it', () => {
    expect(toScreenPoint({ displayId: 'd-1', x: 0, y: 0 }, [primary])).toEqual({ x: 0, y: 0 });
    // The far corner is the last pixel of this display, not the first pixel of
    // the next one along.
    expect(toScreenPoint({ displayId: 'd-1', x: 1, y: 1 }, [primary])).toEqual({ x: 1919, y: 1079 });
    expect(toScreenPoint({ displayId: 'd-1', x: 0.5, y: 0.5 }, [primary])).toEqual({ x: 960, y: 540 });

    // A quarter across a 1920 display is 480, whatever the viewer's window size
    // was - the sender sent a fraction, not a pixel.
    expect(toScreenPoint({ displayId: 'd-1', x: 0.25, y: 0.75 }, [primary])).toEqual({
      x: 480,
      y: 809,
    });
  });

  it('respects a display with a negative origin', () => {
    // A monitor to the left of the primary one. Assuming an origin of (0,0)
    // would put every click on the wrong screen.
    expect(toScreenPoint({ displayId: 'd-2', x: 0, y: 0 }, [primary, secondary])).toEqual({
      x: -2560,
      y: -200,
    });
    expect(toScreenPoint({ displayId: 'd-2', x: 1, y: 1 }, [primary, secondary])).toEqual({
      x: -1,
      y: 1239,
    });
  });

  it('refuses to guess at a display it does not know', () => {
    // Better no click than a click somewhere nobody asked for.
    expect(toScreenPoint({ displayId: 'd-9', x: 0.5, y: 0.5 }, [primary])).toBeUndefined();
    expect(
      toScreenPoint({ displayId: 'd-0', x: 0.5, y: 0.5 }, [
        { displayId: 'd-0', x: 0, y: 0, width: 0, height: 0 },
      ]),
    ).toBeUndefined();
  });

  it('clamps a position a hair outside the surface', () => {
    // Rounding at the sender's end should land on the edge, not be thrown away.
    expect(toScreenPoint({ displayId: 'd-1', x: 1.0001, y: -0.0001 }, [primary])).toEqual({
      x: 1919,
      y: 0,
    });
    expect(toScreenPoint({ displayId: 'd-1', x: Number.NaN, y: 0.5 }, [primary])).toEqual({
      x: 0,
      y: 540,
    });
  });
});
