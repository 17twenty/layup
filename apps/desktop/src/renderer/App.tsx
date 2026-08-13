import { useEffect, useState } from 'react';
import { PROTOCOL_VERSION } from '@layup/protocol';
import { ControlStatus } from './ControlStatus';
import { Identity } from './Identity';
import { RealtimeStatus } from './RealtimeStatus';
import { PeopleGrid } from './people/PeopleGrid';
import { LayupPanel } from './layup/LayupPanel';
import { HappeningNow } from './layup/HappeningNow';
import { Invitations } from './requests/Invitations';
import type { IdentityResponse, LayupStateResponse } from '../shared/ipc';

/**
 * People are the home screen (SPEC.md §2.1). Connection and identity detail is
 * developer chrome at the bottom, not the main event.
 */
export function App() {
  const [identity, setIdentity] = useState<IdentityResponse | undefined>();
  const [layup, setLayup] = useState<LayupStateResponse | undefined>();

  useEffect(() => {
    let cancelled = false;
    void window.layup.identity
      .current()
      .then((next) => {
        if (!cancelled) setIdentity(next);
      })
      .catch(() => undefined);
    const unsubscribe = window.layup.layup.onChanged((next) => {
      if (!cancelled) setLayup(next);
    });
    void window.layup.layup
      .current()
      .then((next) => {
        if (!cancelled) setLayup((current) => current ?? next);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className="shell">
      <header className="shell__header">
        <h1>Layup</h1>
        <p className="tagline">People → Layup → Share → Collaborate</p>
      </header>

      <Invitations currentLayupId={layup?.layup?.id} />
      <HappeningNow />
      <PeopleGrid
        selfUserId={identity?.userId}
        onAction={(person, action) => {
          // A click is a social request, never a media start (SPEC.md §4).
          const currentLayupId = layup?.layup?.id;
          switch (action.kind) {
            case 'start':
              // Already in a layup? Invite them here rather than starting another.
              void window.layup.requests.invite(
                person.userId,
                currentLayupId ? { layupId: currentLayupId } : {},
              );
              return;
            case 'knock':
              // We never learn which private layup they are in.
              void window.layup.requests.knock(person.userId);
              return;
            case 'join':
              // An open layup is joinable directly.
              if (person.layupId) void window.layup.layup.join(person.layupId);
              return;
            default:
              return;
          }
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
