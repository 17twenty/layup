import { beforeEach, describe, expect, it } from 'vitest';
import { MODE_SPECS, boundsFor, createWindowModes, type ModeWindow, type WindowModes } from './window-modes';
import type { Rectangle } from 'electron';

const PRIMARY: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
// A display to the left of and above the primary one: negative origin, as real
// multi-monitor setups have.
const SECOND: Rectangle = { x: -2560, y: -200, width: 2560, height: 1440 };
// A laptop screen too small for the viewer's preferred size.
const SMALL: Rectangle = { x: 0, y: 0, width: 1024, height: 640 };

class FakeWindow implements ModeWindow {
  bounds: Rectangle = { x: 100, y: 100, width: 460, height: 720 };
  minimum = { width: 0, height: 0 };
  resizable = true;
  maximizable = true;
  onTop = false;
  onTopLevel: string | undefined;
  allWorkspaces = false;
  buttonsVisible = true;
  fullScreen = false;
  destroyed = false;
  setBoundsCalls = 0;

  getBounds() {
    return this.bounds;
  }
  setBounds(bounds: Rectangle) {
    this.bounds = bounds;
    this.setBoundsCalls += 1;
  }
  setMinimumSize(width: number, height: number) {
    this.minimum = { width, height };
  }
  setResizable(resizable: boolean) {
    this.resizable = resizable;
  }
  setMaximizable(maximizable: boolean) {
    this.maximizable = maximizable;
  }
  setAlwaysOnTop(top: boolean, level?: string) {
    this.onTop = top;
    this.onTopLevel = level;
  }
  setVisibleOnAllWorkspaces(visible: boolean) {
    this.allWorkspaces = visible;
  }
  setWindowButtonVisibility(visible: boolean) {
    this.buttonsVisible = visible;
  }
  isFullScreen() {
    return this.fullScreen;
  }
  isDestroyed() {
    return this.destroyed;
  }
}

let window: FakeWindow;
let modes: WindowModes;
let pending: Array<{ callback: () => void; delayMs: number }>;
let workArea: Rectangle;

function runTimers() {
  const due = [...pending];
  pending = [];
  for (const entry of due) entry.callback();
}

beforeEach(() => {
  window = new FakeWindow();
  workArea = PRIMARY;
  pending = [];
  modes = createWindowModes({
    window,
    workAreaFor: () => workArea,
    shrinkDelayMs: 2_000,
    schedule: (callback, delayMs) => {
      pending.push({ callback, delayMs });
      return pending.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (handle) => {
      pending.splice((handle as unknown as number) - 1, 1);
    },
  });
});

describe('where a window of each size should sit', () => {
  it('holds the corner it is parked in', () => {
    // Bottom-right: growing must go left and up, not teleport to the middle.
    const bottomRight = boundsFor({
      mode: 'viewer',
      current: { x: 1500, y: 800, width: 360, height: 260 },
      workArea: PRIMARY,
    });
    expect(bottomRight.x + bottomRight.width).toBe(1860);
    expect(bottomRight.y + bottomRight.height).toBe(1060);

    // Top-left: the origin stays put instead.
    const topLeft = boundsFor({
      mode: 'viewer',
      current: { x: 40, y: 40, width: 360, height: 260 },
      workArea: PRIMARY,
    });
    expect(topLeft).toMatchObject({ x: 40, y: 40 });

    // The other two quadrants each hold their own corner.
    const topRight = boundsFor({
      mode: 'viewer',
      current: { x: 1500, y: 40, width: 360, height: 260 },
      workArea: PRIMARY,
    });
    expect(topRight.x + topRight.width).toBe(1860);
    expect(topRight.y).toBe(40);

    const bottomLeft = boundsFor({
      mode: 'viewer',
      current: { x: 40, y: 800, width: 360, height: 260 },
      workArea: PRIMARY,
    });
    expect(bottomLeft.x).toBe(40);
    expect(bottomLeft.y + bottomLeft.height).toBe(1060);
  });

  it('stays on a display with a negative origin', () => {
    const bounds = boundsFor({
      mode: 'viewer',
      current: { x: -400, y: -100, width: 360, height: 260 },
      workArea: SECOND,
    });
    expect(bounds.x).toBeGreaterThanOrEqual(SECOND.x);
    expect(bounds.y).toBeGreaterThanOrEqual(SECOND.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(SECOND.x + SECOND.width);
  });

  it('never asks for more room than the screen has', () => {
    const bounds = boundsFor({
      mode: 'viewer',
      current: { x: 0, y: 0, width: 360, height: 260 },
      workArea: SMALL,
    });
    // The viewer would like 1100x720; this laptop has 1024x640.
    expect(bounds.width).toBe(SMALL.width);
    expect(bounds.height).toBe(SMALL.height);
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
  });

  it('uses the size the person chose, when there is one', () => {
    const bounds = boundsFor({
      mode: 'viewer',
      current: { x: 0, y: 0, width: 360, height: 260 },
      workArea: PRIMARY,
      remembered: { width: 1400, height: 900 },
    });
    expect(bounds).toMatchObject({ width: 1400, height: 900 });
  });
});

describe('changing mode', () => {
  it('grows at once', () => {
    modes.apply('viewer');
    expect(modes.mode()).toBe('viewer');
    expect(window.bounds.width).toBe(MODE_SPECS.viewer.width);
  });

  it('goes small at once when that is what somebody asked for', () => {
    // Joining a layup, or closing the picker, is a deliberate act: no reason to
    // sit at the wrong size for two seconds first.
    modes.apply('compact');
    expect(modes.mode()).toBe('compact');
    expect(window.bounds.width).toBe(MODE_SPECS.compact.width);
  });

  it('waits before leaving the viewer, and never leaves if the screen comes back', () => {
    modes.apply('viewer');
    const grown = window.setBoundsCalls;

    // Somebody switches share source: the screen goes away and comes back.
    modes.apply('compact');
    expect(window.setBoundsCalls).toBe(grown);
    modes.apply('viewer');
    runTimers();

    // The window never moved.
    expect(modes.mode()).toBe('viewer');
    expect(window.setBoundsCalls).toBe(grown);
  });

  it('leaves the viewer once the delay passes', () => {
    modes.apply('viewer');
    modes.apply('compact');
    expect(modes.mode()).toBe('viewer');

    runTimers();

    expect(modes.mode()).toBe('compact');
    expect(window.bounds.width).toBe(MODE_SPECS.compact.width);
  });

  it('floats the small modes and lets the big ones go behind', () => {
    modes.apply('compact');
    expect(window.onTop).toBe(true);
    // Never 'screen-saver': that belongs to the share border, and this must
    // not sit above system dialogs.
    expect(window.onTopLevel).toBe('floating');
    expect(window.allWorkspaces).toBe(true);
    expect(window.buttonsVisible).toBe(false);
    expect(window.maximizable).toBe(false);

    modes.apply('viewer');
    expect(window.onTop).toBe(false);
    expect(window.allWorkspaces).toBe(false);
    expect(window.buttonsVisible).toBe(true);
  });

  it('stays resizable in every mode', () => {
    for (const mode of ['home', 'compact', 'picker', 'viewer'] as const) {
      modes.apply(mode);
      runTimers();
      expect(window.resizable).toBe(true);
    }
  });

  it('waits rather than fighting full screen', () => {
    window.fullScreen = true;
    modes.apply('viewer');

    // macOS ignores setBounds on a full-screen window, which would leave this
    // and the window disagreeing about the mode.
    expect(window.setBoundsCalls).toBe(0);
    expect(modes.mode()).toBe('home');

    window.fullScreen = false;
    modes.resume();
    expect(modes.mode()).toBe('viewer');
  });

  it('waits rather than moving the window out from under a drag', () => {
    modes.hold();
    modes.apply('viewer');
    expect(window.setBoundsCalls).toBe(0);

    modes.resume();
    expect(modes.mode()).toBe('viewer');
  });

  it('remembers a size the person set themselves', () => {
    modes.apply('viewer');
    window.bounds = { ...window.bounds, width: 1400, height: 900 };
    modes.noteUserResize();

    modes.apply('compact');
    runTimers();
    modes.apply('viewer');

    expect(window.bounds).toMatchObject({ width: 1400, height: 900 });
  });

  it('does nothing when asked for the mode it is already in', () => {
    modes.apply('compact');
    runTimers();
    const settled = window.setBoundsCalls;
    modes.apply('compact');
    expect(window.setBoundsCalls).toBe(settled);
  });
});
