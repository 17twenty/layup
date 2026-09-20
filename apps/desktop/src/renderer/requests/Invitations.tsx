import { useEffect, useMemo, useRef, useState } from 'react';
import type { RequestsResponse } from '../../shared/ipc';

type JoinRequest = RequestsResponse['incoming'][number];

/**
 * Traces a card's lifecycle in the console without ever touching a bearer
 * token: only the request id and the reason it is not on screen.
 *
 * This exists because a card that silently stops rendering - accepted,
 * expired, or just mid-flight - is otherwise indistinguishable from a click
 * that did nothing (the exact shape of the report this was added for).
 */
function traceCard(reason: string, fields: Record<string, unknown>) {
  console.debug(`[invitations] ${reason}`, fields);
}

/**
 * Incoming invitations and knocks.
 *
 * Prominent but not modal: the card sits above People so you can see who is
 * asking without losing the rest of the app (SPEC.md §5.2). Accept and decline
 * update immediately - the card never sits there looking un-clicked while the
 * round trip completes.
 */
export interface InvitationsProps {
  /** The layup this desktop is currently in, if any. */
  currentLayupId?: string;
}

export function Invitations({ currentLayupId }: InvitationsProps = {}) {
  const [state, setState] = useState<RequestsResponse>({ incoming: [], outgoing: [] });
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());
  // A message for a request that ran out on its own, keyed by request id so
  // it survives the card itself being dropped from `state`. Without this, a
  // request that expires while just sitting there vanishes with no trace -
  // indistinguishable from one that was quietly acted on.
  const [expiredNotices, setExpiredNotices] = useState<Map<string, string>>(new Map());
  const notifiedExpiryRef = useRef<Set<string>>(new Set());

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

    // Drives the countdown so an expiring request visibly runs out.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  // Catches a request the instant its clock runs out, so it can be announced
  // rather than just dropped from `visible` (Invitations.tsx candidate cause:
  // an expired card silently vanishing). `notifiedExpiryRef` makes this
  // fire once per request, even though it re-checks every tick.
  useEffect(() => {
    const found: Array<{ id: string; message: string }> = [];
    for (const request of state.incoming) {
      if (resolving.has(request.id) || notifiedExpiryRef.current.has(request.id)) continue;
      if (Date.parse(request.expiresAt) > now) continue;
      notifiedExpiryRef.current.add(request.id);
      traceCard('card hidden: expired', { requestId: request.id, direction: 'incoming', expiresAt: request.expiresAt });
      found.push({ id: request.id, message: expiredMessage(request, 'incoming') });
    }
    for (const request of state.outgoing) {
      if (resolving.has(request.id) || notifiedExpiryRef.current.has(request.id)) continue;
      if (Date.parse(request.expiresAt) > now) continue;
      notifiedExpiryRef.current.add(request.id);
      traceCard('card hidden: expired', { requestId: request.id, direction: 'outgoing', expiresAt: request.expiresAt });
      found.push({ id: request.id, message: expiredMessage(request, 'outgoing') });
    }
    if (found.length === 0) return;
    setExpiredNotices((current) => {
      const next = new Map(current);
      for (const { id, message } of found) next.set(id, message);
      return next;
    });
  }, [state, resolving, now]);

  const act = async (requestId: string, action: () => Promise<unknown>) => {
    setError(undefined);
    // Optimistic: the card goes away on click, and comes back if the command
    // fails, so the UI never lies about what happened.
    traceCard('card hidden: resolving', { requestId });
    setResolving((current) => new Set(current).add(requestId));
    try {
      await action();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      traceCard('action failed, restoring card', { requestId, message });
      setError(message);
      setResolving((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    }
  };

  const visible = useMemo(
    () => ({
      incoming: state.incoming.filter((r) => !resolving.has(r.id) && Date.parse(r.expiresAt) > now),
      outgoing: state.outgoing.filter((r) => !resolving.has(r.id) && Date.parse(r.expiresAt) > now),
    }),
    [state, resolving, now],
  );

  const dismissExpired = (requestId: string) =>
    setExpiredNotices((current) => {
      const next = new Map(current);
      next.delete(requestId);
      return next;
    });

  // A failed command or an expiry notice is news even when no card is left
  // to show it next to - hiding the whole section here is what turned a
  // failed accept into a click that silently did nothing.
  if (
    visible.incoming.length === 0 &&
    visible.outgoing.length === 0 &&
    expiredNotices.size === 0 &&
    !error
  ) {
    return null;
  }

  return (
    <section className="requests" aria-label="Invitations">
      {visible.incoming.map((request) => (
        <article key={request.id} className="request" data-testid={`incoming-${request.id}`}>
          <p className="request__headline">{headline(request)}</p>
          {context(request) && <p className="request__context">{context(request)}</p>}
          {request.note && <p className="request__note">“{request.note}”</p>}
          <p className="request__expiry" data-testid={`expiry-${request.id}`}>
            {secondsLeft(request, now)}s left
          </p>
          <div className="request__actions">
            <button
              type="button"
              className="tile__action"
              onClick={() => void act(request.id, () => window.layup.requests.accept(request.id))}
            >
              {request.type === 'KNOCK_TO_JOIN' ? 'Let them in' : busyElsewhere(request, currentLayupId) ? 'Join theirs' : 'Join'}
            </button>

            {busyElsewhere(request, currentLayupId) && (
              <button
                type="button"
                className="tile__action tile__action--secondary"
                onClick={() =>
                  void act(request.id, async () => {
                    // Invite them into the layup we are already in, then answer
                    // theirs. No layups are merged (SPEC.md §6.4).
                    await window.layup.requests.invite(request.fromUserId, { layupId: currentLayupId });
                    await window.layup.requests.decline(request.id);
                  })
                }
              >
                Invite them here
              </button>
            )}

            <button
              type="button"
              className="tile__action tile__action--secondary"
              onClick={() => void act(request.id, () => window.layup.requests.decline(request.id))}
            >
              {busyElsewhere(request, currentLayupId) ? 'Decline' : 'Not now'}
            </button>
          </div>
        </article>
      ))}

      {visible.outgoing.map((request) => (
        <article key={request.id} className="request request--outgoing" data-testid={`outgoing-${request.id}`}>
          <p className="request__headline">
            {request.type === 'KNOCK_TO_JOIN'
              ? 'Knocking…'
              : `Waiting for ${request.toName ?? 'them'}…`}
          </p>
          <div className="request__actions">
            <button
              type="button"
              className="tile__action tile__action--secondary"
              onClick={() => void act(request.id, () => window.layup.requests.cancel(request.id))}
            >
              Cancel
            </button>
          </div>
        </article>
      ))}

      {[...expiredNotices.entries()].map(([requestId, message]) => (
        <p className="request request--expired" data-testid={`expired-${requestId}`} key={requestId}>
          {message}
          <button
            type="button"
            className="tile__action--secondary"
            onClick={() => dismissExpired(requestId)}
          >
            Dismiss
          </button>
        </p>
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
      return `${request.fromName} invited you to a layup`;
    default:
      return `${request.fromName} wants you in a layup`;
  }
}

/**
 * Extra context, privacy-filtered by request type and what the server chose to
 * send. A knock never names the layup; an invitation names it only when the
 * server included a title we are entitled to see.
 */
function context(request: JoinRequest): string | undefined {
  if (request.type === 'KNOCK_TO_JOIN') return 'They want to join the layup you are in';
  if (request.layupTitle) return `“${request.layupTitle}”`;
  return undefined;
}

/**
 * True when this invitation would move us out of a layup we are already in.
 * A knock is never in this category: admitting someone does not move you.
 */
function busyElsewhere(request: JoinRequest, currentLayupId?: string): currentLayupId is string {
  return (
    currentLayupId !== undefined &&
    request.type !== 'KNOCK_TO_JOIN' &&
    request.layupId !== currentLayupId
  );
}

function secondsLeft(request: JoinRequest, now: number): number {
  return Math.max(0, Math.round((Date.parse(request.expiresAt) - now) / 1000));
}

/**
 * What to say when a request runs out on its own, rather than letting the
 * card just disappear. Wording matches `headline`/the outgoing labels above,
 * so it reads as the same event ending rather than a new kind of message.
 */
function expiredMessage(request: JoinRequest, direction: 'incoming' | 'outgoing'): string {
  if (direction === 'outgoing') {
    return request.type === 'KNOCK_TO_JOIN'
      ? 'Your knock expired.'
      : `${request.toName ?? 'They'} did not answer in time.`;
  }
  return request.type === 'KNOCK_TO_JOIN'
    ? `${request.fromName}'s knock expired.`
    : `${request.fromName}'s invitation expired.`;
}
