import { useEffect, useState } from 'react';
import type { ControlStatusResponse } from '../shared/ipc';

/**
 * Developer/status view of the control-plane connection. It is deliberately
 * blunt: a disconnected desktop must say why, not silently look fine.
 */
export function ControlStatus({ pollMs = 5000 }: { pollMs?: number }) {
  const [state, setState] = useState<ControlStatusResponse | undefined>();
  const [failure, setFailure] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await window.layup.control.status();
        if (!cancelled) {
          setState(next);
          setFailure(undefined);
        }
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  if (failure) {
    return (
      <p className="status status--bad" role="status">
        Control service: status unavailable ({failure})
      </p>
    );
  }
  if (!state) {
    return (
      <p className="status" role="status">
        Control service: checking…
      </p>
    );
  }

  const label =
    state.status === 'connected'
      ? `connected · protocol v${state.serverProtocolVersion} · ${state.environment ?? 'unknown env'}${
          state.latencyMs === undefined ? '' : ` · ${Math.round(state.latencyMs)}ms`
        }`
      : `${state.status} — ${state.detail ?? 'no detail'}`;

  return (
    <p className={`status status--${state.status === 'connected' ? 'good' : 'bad'}`} role="status">
      Control service: {label}
      <span className="status__url"> ({state.baseUrl})</span>
    </p>
  );
}
