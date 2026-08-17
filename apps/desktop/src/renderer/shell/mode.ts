/**
 * Which shape the window should be in.
 *
 * The rule the whole design rests on: **small unless there is a reason**. The
 * two reasons are choosing a screen and watching one. Presenting is not a
 * reason - while you share, you are looking at your own screen, and the border
 * around it is the indicator.
 *
 * This is a pure function of three facts, so the interesting cases can be
 * written down as tests rather than discovered by resizing a window by hand.
 */
export type UiMode = 'home' | 'compact' | 'picker' | 'viewer';

export interface ModeInput {
  /** In a layup at all. */
  inLayup: boolean;
  /** The picker is open. */
  pickerOpen: boolean;
  /**
   * A peer's screen track has actually arrived.
   *
   * Deliberately not "somebody is presenting": the control plane says so
   * seconds before any pixels turn up, and growing the window around a black
   * rectangle is worse than growing it late.
   */
  hasIncomingScreen: boolean;
}

export function nextMode(input: ModeInput): UiMode {
  if (!input.inLayup) return 'home';
  // Choosing beats watching, so switching source while somebody is presenting
  // does not fight itself.
  if (input.pickerOpen) return 'picker';
  if (input.hasIncomingScreen) return 'viewer';
  return 'compact';
}
