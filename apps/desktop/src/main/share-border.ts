/**
 * A border drawn around the display you are actually sharing.
 *
 * Everything else that says "you are sharing" lives inside the Layup window,
 * which is exactly the window you are not looking at while you share. This is
 * the indicator that survives that: a frame around the real screen, on top of
 * everything, in every space, that you cannot click through to lose.
 *
 * It has exactly one state, deliberately: **this screen is being shared**.
 *
 * It does not change colour when somebody takes control, because control is not
 * an emergency - it is the point. Several people hold cursors and send input at
 * once, all funnelled through this machine's single mouse and keyboard, so a
 * border that turned red whenever anybody could act would be red for most of a
 * working session, and an alarm that is always on is not an alarm. Who
 * currently holds control belongs in the Layup window, where it can name them
 * and be acted on (SPEC.md §13.3).
 *
 * It is deliberately not a screenshot, a thumbnail or a preview: it never reads
 * a pixel of what is on the screen it frames.
 */
import type { Display, Rectangle } from 'electron';

export type ShareBorderState = 'hidden' | 'sharing';

export interface ShareBorderOptions {
  /** Creates the overlay window. Injected so this is testable without Electron. */
  createWindow: (bounds: Rectangle) => BorderWindow;
  /** The display being shared, from its capture source id. */
  displayFor: (sourceId: string) => Display | undefined;
}

/** The slice of Electron's BrowserWindow this needs. */
export interface BorderWindow {
  setBounds(bounds: Rectangle): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  setAlwaysOnTop(top: boolean, level?: string): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  loadURL(url: string): Promise<void>;
  show(): void;
  hide(): void;
  isDestroyed(): boolean;
  destroy(): void;
}

export interface ShareBorder {
  /** Shows, moves or hides the border. Safe to call with the same state twice. */
  update(input: { sourceId?: string; state: ShareBorderState }): void;
  state(): ShareBorderState;
  dispose(): void;
}

export function createShareBorder(options: ShareBorderOptions): ShareBorder {
  let window: BorderWindow | undefined;
  let state: ShareBorderState = 'hidden';
  let shownFor: string | undefined;

  function hide() {
    state = 'hidden';
    shownFor = undefined;
    if (window && !window.isDestroyed()) window.hide();
  }

  return {
    update({ sourceId, state: next }) {
      if (next === 'hidden' || !sourceId) {
        hide();
        return;
      }

      const display = options.displayFor(sourceId);
      if (!display) {
        // Better no border than a border around the wrong screen: a frame in
        // the wrong place is a lie about what people can see.
        hide();
        return;
      }

      if (!window || window.isDestroyed()) {
        window = options.createWindow(display.bounds);
        // Click-through, on top of full-screen applications, and present in
        // every space - an indicator you can lose behind something is not one.
        window.setIgnoreMouseEvents(true, { forward: true });
        window.setAlwaysOnTop(true, 'screen-saver');
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }

      if (sourceId !== shownFor) window.setBounds(display.bounds);
      if (state !== next || sourceId !== shownFor) {
        void window.loadURL(borderPage(display.bounds));
      }
      window.show();
      state = next;
      shownFor = sourceId;
    },

    state: () => state,

    dispose() {
      if (window && !window.isDestroyed()) window.destroy();
      window = undefined;
      state = 'hidden';
      shownFor = undefined;
    },
  };
}

/**
 * The border itself: a data URL, so there is no file to load, no renderer
 * process doing anything, and nothing that could reach the network.
 */
export function borderPage(bounds: Rectangle): string {
  const colour = '#38d39f';
  const width = 4;
  const label = 'You are sharing this screen';

  const html = `<!doctype html>
<meta charset="utf-8">
<title>${label}</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  .frame {
    position: fixed; inset: 0;
    border: ${width}px solid ${colour};
    border-radius: 6px;
    box-sizing: border-box;
  }
  .label {
    position: fixed; top: 0; left: 50%; transform: translateX(-50%);
    background: ${colour}; color: #0b0d11;
    font: 600 12px/1.6 -apple-system, system-ui, sans-serif;
    padding: 2px 12px; border-radius: 0 0 6px 6px;
  }
</style>
<div class="frame" role="status" aria-label="${label}"></div>
<div class="label">${label}</div>`;

  // Sized from the display so the frame lands on the edges, not inside them.
  void bounds;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
