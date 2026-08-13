import { useEffect, useState } from 'react';
import type { RealtimeStateResponse } from '../shared/ipc';

/**
 * Realtime connection indicator. Pushed from the main process, so it reflects
 * the socket's real state rather than a poll of a cached value.
 */
export function RealtimeStatus() {
  const [state, setState] = useState<RealtimeStateResponse | undefined>();

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.layup.realtime.onState((next) => {
      if (!cancelled) setState(next);
    });
    void window.layup.realtime
      .status()
      .then((next) => {
        if (!cancelled) setState((current) => current ?? next);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const status = state?.status ?? 'idle';
  const detail =
    status === 'connected'
      ? `connection ${state?.connectionId ?? 'unknown'}`
      : status === 'reconnecting'
        ? `attempt ${state?.attempt ?? 1}${state?.lastError ? ` — ${state.lastError}` : ''}`
        : (state?.lastError ?? 'not connected yet');

  return (
    <p className={`status status--${status === 'connected' ? 'good' : 'bad'}`} role="status">
      Realtime: {status} <span className="status__url">({detail})</span>
    </p>
  );
}
