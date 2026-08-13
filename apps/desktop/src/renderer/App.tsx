import { useEffect, useState } from 'react';
import { PROTOCOL_VERSION } from '@layup/protocol';
import { ControlStatus } from './ControlStatus';
import { Identity } from './Identity';
import { RealtimeStatus } from './RealtimeStatus';
import { PeopleGrid } from './people/PeopleGrid';
import { LayupPanel } from './layup/LayupPanel';
import { Invitations } from './requests/Invitations';
import type { IdentityResponse } from '../shared/ipc';

/**
 * People are the home screen (SPEC.md §2.1). Connection and identity detail is
 * developer chrome at the bottom, not the main event.
 */
export function App() {
  const [identity, setIdentity] = useState<IdentityResponse | undefined>();

  useEffect(() => {
    let cancelled = false;
    void window.layup.identity
      .current()
      .then((next) => {
        if (!cancelled) setIdentity(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="shell">
      <header className="shell__header">
        <h1>Layup</h1>
        <p className="tagline">People → Layup → Share → Collaborate</p>
      </header>

      <Invitations />
      <PeopleGrid
        selfUserId={identity?.userId}
        onAction={(person, action) => {
          // A click is a social request, never a media start (SPEC.md §4).
          if (action.kind === 'start') void window.layup.requests.invite(person.userId);
        }}
      />
      <LayupPanel />

      <footer className="shell__footer">
        <Identity />
        <ControlStatus />
        <RealtimeStatus />
        <p className="meta">protocol v{PROTOCOL_VERSION}</p>
      </footer>
    </div>
  );
}
