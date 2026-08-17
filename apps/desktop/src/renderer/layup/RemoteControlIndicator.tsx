import type { RemoteControlState } from '../../core/remote-control';

/**
 * The "somebody else can act on this machine" indicator (SPEC.md §13.3).
 *
 * Mandatory, and mandatory for a reason: remote control is the one feature
 * where not noticing has real consequences. So this is not a subtle badge in a
 * settings panel. It is a persistent banner with the stop button in it, shown
 * whenever anybody holds control, whatever else the presenter is looking at.
 *
 * It also names the shortcut, because the moment somebody needs it is the
 * moment they will not go looking for it.
 */
export interface RemoteControlIndicatorProps {
  state: RemoteControlState;
  /** The global emergency shortcut, or undefined when the OS refused it. */
  shortcut?: string;
  onStopAll: () => void;
}

export function RemoteControlIndicator({ state, shortcut, onStopAll }: RemoteControlIndicatorProps) {
  // Nothing to say when nobody has control: an indicator that is always on
  // stops being an indicator.
  if (!state.anyoneHasControl) return null;

  const shared = (['pointer', 'keyboard'] as const)
    .filter((scope) => state.allowed[scope])
    .map((scope) => (scope === 'pointer' ? 'mouse' : 'keyboard'));
  const stopped = state.stopped.length;

  return (
    <aside
      className="remote-banner"
      data-testid="remote-control-banner"
      // Assertive: this is exactly the case a screen-reader user must not have
      // to discover for themselves.
      role="alert"
      aria-live="assertive"
    >
      <span className="remote-banner__dot" aria-hidden="true" />
      <p className="remote-banner__text">
        Everyone here can use your {shared.join(' and ')}.
        {stopped > 0 ? ` ${stopped} stopped.` : ''}
      </p>
      <button type="button" className="remote-banner__stop" onClick={onStopAll} data-testid="stop-all">
        Stop
      </button>
      {shortcut ? (
        <span className="remote-banner__shortcut" data-testid="stop-shortcut">
          or press {shortcut}
        </span>
      ) : null}
    </aside>
  );
}

