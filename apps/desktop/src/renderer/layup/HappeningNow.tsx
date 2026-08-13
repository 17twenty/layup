import { useCallback, useEffect, useState } from 'react';
import type { OpenLayupsResponse } from '../../shared/ipc';

/**
 * Happening Now: organisation-open layups anyone here can walk into.
 *
 * Private layups never appear - not their title, not their participants, not
 * their existence (SPEC.md §5.3).
 */
export function HappeningNow() {
  const [layups, setLayups] = useState<OpenLayupsResponse['layups']>([]);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const next = await window.layup.layup.open();
      setLayups(next.layups);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Membership changes anywhere in the organisation change this list, and
    // those arrive as presence updates.
    const unsubscribePeople = window.layup.people.onChanged(() => void refresh());
    const unsubscribeLayup = window.layup.layup.onChanged(() => void refresh());
    return () => {
      unsubscribePeople();
      unsubscribeLayup();
    };
  }, [refresh]);

  if (layups.length === 0) return null;

  return (
    <section className="happening" aria-label="Happening now">
      <h2>Happening now</h2>
      <ul className="happening__list">
        {layups.map((layup) => (
          <li key={layup.id} className="happening__item" data-testid={`open-${layup.id}`}>
            <div>
              <p className="tile__name">{layup.title || 'Untitled layup'}</p>
              <p className="tile__presence">
                {layup.participants.join(', ')} · {layup.participantCount}{' '}
                {layup.participantCount === 1 ? 'person' : 'people'}
                {layup.presenterName ? ` · ${layup.presenterName} is sharing` : ''}
              </p>
            </div>
            <button
              type="button"
              className="tile__action"
              disabled={!layup.canJoin}
              onClick={() => void window.layup.layup.join(layup.id).catch(() => undefined)}
            >
              {layup.youAreInIt ? 'You are here' : 'Join'}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="layup__error">{error}</p>}
    </section>
  );
}
