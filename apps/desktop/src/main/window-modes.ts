/**
 * How big the window is, and where (the Pop/Screenhero shape).
 *
 * The application is normally a small floating pill: the people you are with,
 * your camera and microphone, and nothing else. It grows only when it has to -
 * to choose a screen, or to show you somebody else's - and shrinks straight
 * back. Presenting keeps you small, because while you share you are looking at
 * your own screen and the border around it is the indicator, not this window.
 *
 * The renderer says *which mode*; this decides what that means in pixels. The
 * boundary is deliberate: a renderer that could set bounds on an always-on-top
 * frameless window could place content pixel-perfectly over OS chrome. One of
 * four names is not that.
 *
 * Everything below exists to stop the window feeling like it is jumping about:
 * it grows from the corner it is parked in, remembers the size you dragged it
 * to, stays on the display it is on, and refuses to move while you are dragging
 * it or while it is full screen.
 */
import type { Rectangle } from 'electron';

export type UiMode = 'home' | 'compact' | 'picker' | 'viewer';

export const UI_MODES = ['home', 'compact', 'picker', 'viewer'] as const;

export interface ModeSpec {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** Floating above other applications. Only for the small modes. */
  alwaysOnTop: boolean;
  /** Follows you between Spaces. Only the pill should. */
  allWorkspaces: boolean;
  maximizable: boolean;
}

export const MODE_SPECS: Record<UiMode, ModeSpec> = {
  // The directory: a contacts window, not a dashboard.
  home: { width: 460, height: 720, minWidth: 380, minHeight: 480, alwaysOnTop: false, allWorkspaces: false, maximizable: true },
  // A call: portrait, because faces stack, and small enough to leave in the
  // corner of a screen you are working on. Resizable from there.
  compact: { width: 380, height: 620, minWidth: 280, minHeight: 300, alwaysOnTop: true, allWorkspaces: true, maximizable: false },
  // Big enough for a grid of screen thumbnails, no bigger.
  picker: { width: 760, height: 560, minWidth: 520, minHeight: 400, alwaysOnTop: true, allWorkspaces: false, maximizable: false },
  // Somebody else's screen: the one thing worth a large window.
  viewer: { width: 1100, height: 720, minWidth: 640, minHeight: 480, alwaysOnTop: false, allWorkspaces: false, maximizable: true },
};

/** The slice of BrowserWindow this needs, so it can be tested with a fake. */
export interface ModeWindow {
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle, animate?: boolean): void;
  setMinimumSize(width: number, height: number): void;
  setResizable(resizable: boolean): void;
  setMaximizable(maximizable: boolean): void;
  setAlwaysOnTop(top: boolean, level?: string): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  setWindowButtonVisibility?(visible: boolean): void;
  isFullScreen(): boolean;
  isDestroyed(): boolean;
}

export interface WindowModes {
  /** Asks for a mode. Applying it may be deferred; it is never dropped. */
  apply(mode: UiMode): void;
  mode(): UiMode;
  /** Remembers a size the person chose themselves. */
  noteUserResize(): void;
  /** Applies anything that was waiting on a drag or on full screen. */
  resume(): void;
  /** Suspends resizing while the window is being dragged or resized. */
  hold(): void;
  dispose(): void;
}

export interface WindowModesOptions {
  window: ModeWindow;
  /** The work area of the display the window is on. */
  workAreaFor: (bounds: Rectangle) => Rectangle;
  /** Sizes the person chose, per mode. Injected so it can be seeded in tests. */
  remembered?: Map<UiMode, { width: number; height: number }>;
  /**
   * How long a shrink waits before it happens.
   *
   * Switching share source stops one share and starts another, so the screen
   * briefly goes away and comes back. Without this, every switch is a
   * shrink-then-grow lurch.
   */
  shrinkDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
  onApplied?: (mode: UiMode) => void;
}

/**
 * Where a window of this size should sit, given where it is now.
 *
 * Pure, and the reason this module is testable: the corner nearest the window's
 * centre is held fixed, so a pill parked bottom-right grows leftwards and
 * upwards instead of teleporting to the middle of the screen.
 */
export function boundsFor(input: {
  mode: UiMode;
  current: Rectangle;
  workArea: Rectangle;
  remembered?: { width: number; height: number };
}): Rectangle {
  const spec = MODE_SPECS[input.mode];
  const wanted = input.remembered ?? { width: spec.width, height: spec.height };

  // Never larger than the screen it is on.
  const width = Math.max(spec.minWidth, Math.min(wanted.width, input.workArea.width));
  const height = Math.max(spec.minHeight, Math.min(wanted.height, input.workArea.height));

  const centreX = input.current.x + input.current.width / 2;
  const centreY = input.current.y + input.current.height / 2;
  const workCentreX = input.workArea.x + input.workArea.width / 2;
  const workCentreY = input.workArea.y + input.workArea.height / 2;

  // Hold the nearest corner still.
  const x = centreX <= workCentreX ? input.current.x : input.current.x + input.current.width - width;
  const y = centreY <= workCentreY ? input.current.y : input.current.y + input.current.height - height;

  return {
    width,
    height,
    x: clamp(x, input.workArea.x, input.workArea.x + input.workArea.width - width),
    y: clamp(y, input.workArea.y, input.workArea.y + input.workArea.height - height),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.round(Math.max(low, Math.min(value, high)));
}

/**
 * Whether a change should wait a moment before it happens.
 *
 * Only leaving the viewer does. Everything else is a deliberate act - joining a
 * layup, closing the picker - and should feel immediate. Leaving the viewer is
 * the one transition that can be a false alarm: switching share source stops
 * one share and starts another, so the screen goes away and comes back within a
 * second, and without the wait every switch is a shrink-then-grow lurch.
 */
export function shouldWait(from: UiMode, to: UiMode): boolean {
  const area = (mode: UiMode) => MODE_SPECS[mode].width * MODE_SPECS[mode].height;
  return from === 'viewer' && area(to) < area(from);
}

export function createWindowModes(options: WindowModesOptions): WindowModes {
  const shrinkDelayMs = options.shrinkDelayMs ?? 2_000;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));
  const remembered = options.remembered ?? new Map<UiMode, { width: number; height: number }>();

  let current: UiMode = 'home';
  let pending: UiMode | undefined;
  let shrinkTimer: ReturnType<typeof setTimeout> | undefined;
  let held = false;

  function clearShrink() {
    if (shrinkTimer) cancel(shrinkTimer);
    shrinkTimer = undefined;
  }

  function put(mode: UiMode) {
    const window = options.window;
    if (window.isDestroyed()) return;

    // Resizing a full-screen window is silently ignored on macOS, which would
    // leave this and the window disagreeing. Wait for it to come back.
    if (window.isFullScreen() || held) {
      pending = mode;
      return;
    }

    const spec = MODE_SPECS[mode];
    const bounds = boundsFor({
      mode,
      current: window.getBounds(),
      workArea: options.workAreaFor(window.getBounds()),
      ...(remembered.has(mode) ? { remembered: remembered.get(mode)! } : {}),
    });

    window.setMinimumSize(spec.minWidth, spec.minHeight);
    // Resizable in every mode: a window that refuses to be resized feels
    // broken, and remembering a size only means anything if you can set one.
    window.setResizable(true);
    window.setMaximizable(spec.maximizable);
    // 'floating', never 'screen-saver' - that level belongs to the share
    // border, and this window must not sit above system dialogs.
    window.setAlwaysOnTop(spec.alwaysOnTop, 'floating');
    window.setVisibleOnAllWorkspaces(spec.allWorkspaces, { visibleOnFullScreen: spec.allWorkspaces });
    // The traffic lights would be a quarter of the pill.
    window.setWindowButtonVisibility?.(mode !== 'compact');
    // No animation: AppKit's stutters against live video, and the renderer is
    // relaying out at the same moment anyway.
    window.setBounds(bounds, false);

    current = mode;
    pending = undefined;
    options.onApplied?.(mode);
  }

  return {
    apply(mode) {
      if (mode === current && !pending) {
        clearShrink();
        return;
      }

      if (shouldWait(current, mode)) {
        // Wait, in case this is the gap in the middle of switching source.
        clearShrink();
        shrinkTimer = schedule(() => {
          shrinkTimer = undefined;
          put(mode);
        }, shrinkDelayMs);
        return;
      }

      // Growing is never delayed, and cancels a shrink that had not happened.
      clearShrink();
      put(mode);
    },

    mode: () => current,

    noteUserResize() {
      if (options.window.isDestroyed()) return;
      const bounds = options.window.getBounds();
      remembered.set(current, { width: bounds.width, height: bounds.height });
    },

    hold() {
      held = true;
    },

    resume() {
      held = false;
      if (pending) put(pending);
    },

    dispose() {
      clearShrink();
      pending = undefined;
    },
  };
}
