import { useEffect, useState } from 'react';
import type { IdentityResponse } from '../shared/ipc';

/**
 * Who this desktop is running as, and the way out when that has stopped
 * working.
 *
 * Two local clients differ only by LAYUP_DEV_USER, so showing it prominently
 * is what stops "why did Karl's click land as Nick?" confusion during
 * development.
 *
 * "Forget this server" lives here because here is where the trouble shows.
 * `server:forget` existed from the day the config did with nothing anywhere
 * that could call it, so a token the server had stopped recognising left a
 * window that said "Identity unresolved" and offered nothing - and deleting
 * config.json from Application Support by hand was the only cure. It is needed
 * most in the state where nothing else on the screen works.
 *
 * The two unresolved states are worded differently on purpose. A refused
 * credential means this desktop has been signed out and the server has to be
 * added again; a server that cannot be reached means wait, and the config is
 * still the right one. Saying the first when the second is true is how flaky
 * wifi comes to look like being logged out.
 */
export function Identity() {
  const [identity, setIdentity] = useState<IdentityResponse | undefined>();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await window.layup.identity.current();
        if (!cancelled) setIdentity(next);
      } catch {
        if (!cancelled) setIdentity(undefined);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!identity) {
    return (
      <p className="identity" role="note">
        Identity: resolving…
      </p>
    );
  }

  const forget = (
    <button
      type="button"
      className={
        identity.credentialsRejected ? 'shell__footer-link shell__footer-link--urgent' : 'shell__footer-link'
      }
      onClick={() => void window.layup.server.forget()}
      data-testid="forget-server"
    >
      Forget this server
    </button>
  );

  return (
    <p className={`identity ${identity.resolved ? '' : 'identity--unresolved'}`} role="note">
      {identity.resolved ? (
        <>
          You are <strong>{identity.displayName}</strong> · {identity.organisationName} ·{' '}
          <span className="identity__handle">LAYUP_DEV_USER={identity.devUser}</span>
        </>
      ) : identity.credentialsRejected ? (
        <>
          This server no longer recognises this desktop — add the server again to sign back in
          ({identity.detail ?? 'no detail'}).
        </>
      ) : (
        <>
          Identity <strong>{identity.devUser}</strong> unresolved — {identity.detail ?? 'no detail'}
        </>
      )}{' '}
      {forget}
    </p>
  );
}
