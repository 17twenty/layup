import { useEffect, useState } from 'react';
import type { RequestsResponse } from '../../shared/ipc';

type JoinRequest = RequestsResponse['incoming'][number];

/**
 * Pending invitations and knocks.
 *
 * Incoming requests are prominent but do not take over the app: you can keep
 * looking at People while deciding (SPEC.md §5.2).
 */
export function Invitations() {
  const [state, setState] = useState<RequestsResponse>({ incoming: [], outgoing: [] });
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.layup.requests.onChanged((next) => {
      if (!cancelled) setState(next);
    });
    void window.layup.requests
      .list()
      .then((next) => {
        if (!cancelled) setState((current) => (current.incoming.length ? current : next));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const act = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (state.incoming.length === 0 && state.outgoing.length === 0) return null;

  return (
    <section className="requests" aria-label="Invitations">
      {state.incoming.map((request) => (
        <article key={request.id} className="request" data-testid={`incoming-${request.id}`}>
          <p className="request__headline">{headline(request)}</p>
          {request.note && <p className="request__note">“{request.note}”</p>}
          <div className="request__actions">
            <button
              type="button"
              className="tile__action"
              onClick={() => void act(() => window.layup.requests.accept(request.id))}
            >
              Join
            </button>
            <button
              type="button"
              className="tile__action tile__action--secondary"
              onClick={() => void act(() => window.layup.requests.decline(request.id))}
            >
              Not now
            </button>
          </div>
        </article>
      ))}

      {state.outgoing.map((request) => (
        <article key={request.id} className="request request--outgoing" data-testid={`outgoing-${request.id}`}>
          <p className="request__headline">Waiting for {request.toName ?? 'them'}…</p>
          <div className="request__actions">
            <button
              type="button"
              className="tile__action tile__action--secondary"
              onClick={() => void act(() => window.layup.requests.cancel(request.id))}
            >
              Cancel
            </button>
          </div>
        </article>
      ))}

      {error && <p className="layup__error">{error}</p>}
    </section>
  );
}

function headline(request: JoinRequest): string {
  switch (request.type) {
    case 'KNOCK_TO_JOIN':
      return `${request.fromName} is knocking`;
    case 'INVITE_USER_TO_LAYUP':
      return request.layupTitle
        ? `${request.fromName} invited you to “${request.layupTitle}”`
        : `${request.fromName} invited you to a layup`;
    default:
      return `${request.fromName} wants you in a layup`;
  }
}
