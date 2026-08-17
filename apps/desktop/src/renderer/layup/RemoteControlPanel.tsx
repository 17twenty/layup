import type { ControlScope } from '@layup/protocol';
import type { RemoteControlState } from '../../core/remote-control';

/**
 * Two switches (SPEC.md §7.3, ADR-0005).
 *
 * Sharing the mouse and keyboard is a mode, not a permissions matrix: everyone
 * in the layup is someone you chose to be in a room with, and several of them
 * acting at once - funnelled through this machine's one mouse and keyboard - is
 * what the feature is for.
 *
 * Stopping one person exists, and is deliberately not on this panel by default:
 * it appears next to somebody only once they are actually interacting, because
 * that is the only moment it means anything.
 *
 * Nothing here asks about creators or moderators. A layup creator has no say
 * over somebody else's keyboard; the only question is "is this my screen?".
 */
export interface RemoteControlPanelProps {
  state: RemoteControlState;
  /** Who is in the layup, other than you. */
  participants: Array<{ membershipId: string; displayName: string }>;
  onSetAllowed: (scope: ControlScope, allowed: boolean) => void;
  onStop: (membershipId: string) => void;
  onResume: (membershipId: string) => void;
}

const SCOPES: Array<{ scope: ControlScope; label: string }> = [
  { scope: 'pointer', label: 'Mouse' },
  { scope: 'keyboard', label: 'Keyboard' },
];

export function RemoteControlPanel({
  state,
  participants,
  onSetAllowed,
  onStop,
  onResume,
}: RemoteControlPanelProps) {
  const stopped = new Map(state.stopped.map((entry) => [entry.membershipId, entry.scopes]));
  const sharing = SCOPES.filter(({ scope }) => state.allowed[scope]).map(({ label }) =>
    label.toLowerCase(),
  );

  return (
    <section className="control" aria-label="Sharing control of this machine">
      <div className="control__switches">
        {SCOPES.map(({ scope, label }) => (
          <label key={scope} className="control__switch">
            <input
              type="checkbox"
              checked={state.allowed[scope]}
              onChange={(event) => onSetAllowed(scope, event.target.checked)}
              data-testid={`allow-${scope}`}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <p className="control__summary" data-testid="control-summary">
        {sharing.length === 0
          ? 'Only you can use this machine.'
          : `Everyone here can use your ${sharing.join(' and ')}.`}
      </p>

      {stopped.size > 0 ? (
        <ul className="control__people">
          {[...stopped.keys()].map((membershipId) => {
            const person = participants.find((entry) => entry.membershipId === membershipId);
            return (
              <li key={membershipId} className="control__person">
                <span className="control__name">{person?.displayName ?? 'Someone'}</span>
                <span className="control__scopes">stopped</span>
                <button
                  type="button"
                  onClick={() => onResume(membershipId)}
                  data-testid={`resume-${membershipId}`}
                >
                  Let back in
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Stopping somebody is the exception, so it lives with the people, not
          with the switches - and only while sharing is actually on. */}
      {sharing.length > 0 && participants.length > 0 ? (
        <details className="control__more">
          <summary>Stop one person</summary>
          <ul className="control__people">
            {participants
              .filter((participant) => !stopped.has(participant.membershipId))
              .map((participant) => (
                <li key={participant.membershipId} className="control__person">
                  <span className="control__name">{participant.displayName}</span>
                  <button
                    type="button"
                    onClick={() => onStop(participant.membershipId)}
                    data-testid={`stop-${participant.membershipId}`}
                  >
                    Stop
                  </button>
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
