import type { ControlScope } from '@layup/protocol';
import type { RemoteControlState } from '../../core/remote-control';

/**
 * The presenter's remote-control switches (SPEC.md §7.3, ADR-0005).
 *
 * This panel only ever appears on the machine being shared, because the
 * decisions it makes are about that machine. It asks nothing about who created
 * the layup: a creator has no authority over somebody else's keyboard.
 *
 * Two things are deliberate about the layout. The switches read as plain
 * statements of what is on, not as permissions being administered. And "Stop
 * all control" is always present while anybody holds control, so revoking never
 * requires finding the right participant first.
 */
export interface RemoteControlPanelProps {
  state: RemoteControlState;
  /** Participants who could be given control - never including yourself. */
  participants: Array<{ membershipId: string; displayName: string }>;
  onSetAllowed: (scope: ControlScope, allowed: boolean) => void;
  onGrant: (membershipId: string, scope: ControlScope) => void;
  onRevoke: (membershipId: string) => void;
  onRevokeAll: () => void;
}

const SCOPES: Array<{ scope: ControlScope; label: string }> = [
  { scope: 'pointer', label: 'Mouse' },
  { scope: 'keyboard', label: 'Keyboard' },
];

export function RemoteControlPanel({
  state,
  participants,
  onSetAllowed,
  onGrant,
  onRevoke,
  onRevokeAll,
}: RemoteControlPanelProps) {
  const holders = new Map(state.grants.map((grant) => [grant.membershipId, grant.scopes]));

  return (
    <section className="control" aria-label="Remote control">
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

      {state.anyoneHasControl ? (
        <p className="control__indicator" data-testid="control-indicator" role="status">
          {describeHolders(state, participants)} can control this machine.
        </p>
      ) : (
        <p className="control__indicator control__indicator--idle" data-testid="control-indicator">
          Nobody can control this machine.
        </p>
      )}

      <ul className="control__people">
        {participants.map((participant) => {
          const scopes = holders.get(participant.membershipId) ?? [];
          return (
            <li key={participant.membershipId} className="control__person">
              <span className="control__name">{participant.displayName}</span>
              {scopes.length > 0 ? (
                <>
                  <span className="control__scopes" data-testid={`scopes-${participant.membershipId}`}>
                    {scopes.map((scope) => scopeLabel(scope)).join(' + ')}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRevoke(participant.membershipId)}
                    data-testid={`revoke-${participant.membershipId}`}
                  >
                    Stop
                  </button>
                </>
              ) : (
                SCOPES.map(({ scope, label }) => (
                  <button
                    key={scope}
                    type="button"
                    // A switch that is off is the presenter's answer already:
                    // the button says why rather than failing silently.
                    disabled={!state.allowed[scope]}
                    title={state.allowed[scope] ? undefined : `${label} control is switched off`}
                    onClick={() => onGrant(participant.membershipId, scope)}
                    data-testid={`grant-${scope}-${participant.membershipId}`}
                  >
                    Give {label.toLowerCase()}
                  </button>
                ))
              )}
            </li>
          );
        })}
      </ul>

      {state.anyoneHasControl ? (
        <button
          type="button"
          className="control__stop"
          onClick={onRevokeAll}
          data-testid="revoke-all"
        >
          Stop all control
        </button>
      ) : null}
    </section>
  );
}

function scopeLabel(scope: ControlScope): string {
  return scope === 'pointer' ? 'mouse' : 'keyboard';
}

function describeHolders(
  state: RemoteControlState,
  participants: Array<{ membershipId: string; displayName: string }>,
): string {
  const names = state.grants.map(
    (grant) =>
      participants.find((participant) => participant.membershipId === grant.membershipId)?.displayName ??
      'Someone',
  );
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
