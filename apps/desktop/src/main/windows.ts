/**
 * Which window is *the* window.
 *
 * The desktop has more than one now - the share border frames a display, and
 * more overlays will follow - and almost nothing that used to say "all windows"
 * meant it. Pushing state to every window means pushing it to overlays that
 * have no preload to receive it; badging and flashing every window means
 * flashing a click-through border; and counting every window means the dock
 * icon stops reopening the app, because an overlay is still technically open.
 *
 * So the application window is named here, once, and everything that means
 * "the app" asks for it.
 */
export interface AppWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  setTitle(title: string): void;
  setOverlayIcon(icon: unknown, description: string): void;
  flashFrame(flag: boolean): void;
  webContents: { send(channel: string, payload?: unknown): void };
}

export interface WindowRegistry<W extends AppWindow = AppWindow> {
  /** Records the application window. Replaces any previous one. */
  set(window: W): W;
  /** The application window, if it is open. */
  current(): W | undefined;
  /** Whether the application window is open - not counting overlays. */
  isOpen(): boolean;
  /** Sends a validated event to the application window. */
  send(event: string, payload?: unknown): void;
  /** Runs something with the window, if there is one. */
  withWindow(run: (window: W) => void): void;
  clear(): void;
}

export function createWindowRegistry<W extends AppWindow = AppWindow>(): WindowRegistry<W> {
  let main: W | undefined;

  const live = (): W | undefined => (main && !main.isDestroyed() ? main : undefined);

  return {
    set(window) {
      main = window;
      return window;
    },
    current: live,
    isOpen: () => live() !== undefined,
    send(event, payload) {
      live()?.webContents.send(event, payload);
    },
    withWindow(run) {
      const window = live();
      if (window) run(window);
    },
    clear() {
      main = undefined;
    },
  };
}
