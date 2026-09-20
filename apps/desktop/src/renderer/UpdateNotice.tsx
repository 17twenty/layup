import { useEffect, useState } from 'react';
import type { UpdateStateResponse } from '../shared/ipc';

/**
 * The quietest possible way to say "there is a newer Layup".
 *
 * It lives in the footer of the home screen and nowhere else. There is no
 * dialog, no toast and no countdown, because the one moment this must never
 * interrupt is a layup - and the footer does not exist while you are in one.
 * Clicking asks the privileged side to restart; if a layup started in the
 * meantime it says no, and the line simply stays where it was.
 */
export function UpdateNotice() {
  const [state, setState] = useState<UpdateStateResponse>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.layup.update.onChanged((next) => {
      if (!cancelled) setState(next);
    });
    void window.layup.update
      .state()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      // Not knowing about an update is not worth a word on screen.
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (state.status === 'ready') {
    return (
      <p className="update update--ready">
        <button
          type="button"
          className="update__restart"
          onClick={() => void window.layup.update.install()}
        >
          Update ready{state.version ? ` (v${state.version})` : ''} — restart Layup
        </button>
      </p>
    );
  }

  if (state.status === 'error') {
    // Readable, and beside the other developer chrome: a feed we cannot reach
    // is worth knowing about, and worth nobody's attention beyond that.
    return (
      <p className="update update--error" role="status">
        Update check failed — {state.message ?? 'no detail given'}
      </p>
    );
  }

  if (state.status === 'downloading') {
    return (
      <p className="update" role="status">
        Downloading update{state.version ? ` v${state.version}` : ''}
        {state.message ? ` — ${state.message}` : '…'}
      </p>
    );
  }

  // idle, checking and available are not news: the download is automatic, and
  // the only thing anybody has to do anything about is a restart.
  return null;
}
