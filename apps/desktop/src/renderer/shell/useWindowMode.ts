import { useEffect } from 'react';
import { nextMode, type ModeInput, type UiMode } from './mode';

/**
 * Keeps the window's shape and the layout in step.
 *
 * Both come from the same value in the same render, so the window resizes and
 * the interface relays out together. Waiting for the main process to confirm
 * would show a compact layout inside a viewer-sized window for a frame, which
 * reads as a flash.
 *
 * Main can defer a resize - while the window is being dragged, or while it is
 * full screen - and the layout is deliberately not held back for that. A
 * compact layout in a window that has not shrunk yet is momentarily roomy; the
 * reverse is a broken-looking window.
 */
export function useWindowMode(input: ModeInput): UiMode {
  const mode = nextMode(input);

  useEffect(() => {
    void window.layup.ui.setMode(mode).catch(() => undefined);
  }, [mode]);

  return mode;
}
