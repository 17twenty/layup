import { useAttentionSound } from '../sound';

/**
 * The strip behind the traffic lights.
 *
 * `main/index.ts` sets `titleBarStyle: 'hidden'` with `trafficLightPosition:
 * {x:12,y:12}` on macOS, so the traffic lights float over whatever the app
 * draws there - and the app has to hand that strip back as a drag region
 * itself, or the window becomes undraggable from the top (task 11).
 *
 * Rendered once, by the shell, above every view - the waiting screen, the
 * add-server screen, the directory and the layup room alike - so a new screen
 * can never forget to supply one. `App.tsx` no longer relies on any one
 * view's own header for this.
 *
 * It doubles as the one place a "mute notification sounds" toggle can live
 * where it is reachable from anywhere: it is not part of any call surface or
 * onboarding flow, so it has no other natural home (task 8).
 */
export function TitleBar() {
  const sound = useAttentionSound();

  return (
    <div className="titlebar drag" data-testid="titlebar">
      <button
        type="button"
        className="titlebar__mute no-drag"
        aria-pressed={sound.muted}
        onClick={() => sound.setMuted(!sound.muted)}
        title={sound.muted ? 'Unmute notification sounds' : 'Mute notification sounds'}
        data-testid="mute-toggle"
      >
        {sound.muted ? '🔕' : '🔔'}
      </button>
    </div>
  );
}
