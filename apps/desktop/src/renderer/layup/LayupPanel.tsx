import { useEffect, useState } from 'react';
import type { LayupStateResponse } from '../../shared/ipc';

/**
 * The layup you are in: who is here, and how to leave.
 *
 * There is no host badge and no "make someone else the owner" control - a layup
 * with no creator authority is completely normal (SPEC.md §2.2).
 */
export function LayupPanel() {
  const [state, setState] = useState<LayupStateResponse | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.layup.layup.onChanged((next) => {
      if (!cancelled) setState(next);
    });
    void window.layup.layup
      .current()
      .then((next) => {
        if (!cancelled) setState((current) => current ?? next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const layup = state?.layup;

  if (!layup) {
    return (
      <section className="layup" aria-label="Layup">
        <p className="layup__empty">You are not in a layup.</p>
        <button
          type="button"
          className="tile__action tile__action--secondary"
          disabled={busy}
          onClick={() => void run(() => window.layup.layup.create({ visibility: 'ORGANISATION' }))}
        >
          Start an open layup
        </button>
        {error && <p className="layup__error">{error}</p>}
      </section>
    );
  }

  const participants = layup.participants.filter((participant) => !participant.leftAt);

  return (
    <section className="layup" aria-label="Layup">
      <header className="layup__header">
        <h2>{layup.title || 'Layup'}</h2>
        <span className="layup__visibility">{layup.visibility.toLowerCase()}</span>
      </header>

      <ul className="layup__participants">
        {participants.map((participant) => (
          <li key={participant.membershipId} data-testid={`participant-${participant.membershipId}`}>
            {participant.displayName}
            {participant.isCreatorMembership && <span className="layup__tag">creator</span>}
            {participant.membershipId === state?.membershipId && <span className="layup__tag">you</span>}
          </li>
        ))}
      </ul>

      {!layup.hasCreatorAuthority && (
        <p className="layup__note" data-testid="no-creator">
          The person who started this has left.
        </p>
      )}

      <button
        type="button"
        className="tile__action tile__action--secondary"
        disabled={busy}
        onClick={() => void run(() => window.layup.layup.leave())}
      >
        Leave
      </button>
      {error && <p className="layup__error">{error}</p>}
    </section>
  );
}
