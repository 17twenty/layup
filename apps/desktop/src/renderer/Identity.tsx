import { useEffect, useState } from 'react';
import type { IdentityResponse } from '../shared/ipc';

/**
 * Who this desktop is running as. Two local clients differ only by
 * LAYUP_DEV_USER, so showing it prominently is what stops "why did Karl's
 * click land as Nick?" confusion during development.
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

  return (
    <p className={`identity ${identity.resolved ? '' : 'identity--unresolved'}`} role="note">
      {identity.resolved ? (
        <>
          You are <strong>{identity.displayName}</strong> · {identity.organisationName} ·{' '}
          <span className="identity__handle">LAYUP_DEV_USER={identity.devUser}</span>
        </>
      ) : (
        <>
          Identity <strong>{identity.devUser}</strong> unresolved — {identity.detail ?? 'no detail'}
        </>
      )}
    </p>
  );
}
