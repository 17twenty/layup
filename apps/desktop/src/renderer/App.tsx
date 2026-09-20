import { useEffect, useState } from 'react';
import { PROTOCOL_VERSION } from '@layup/protocol';
import { BUILD_INFO } from '../shared/build-info';
import { ControlStatus } from './ControlStatus';
import { Identity } from './Identity';
import { RealtimeStatus } from './RealtimeStatus';
import { UpdateNotice } from './UpdateNotice';
import { PeopleGrid } from './people/PeopleGrid';
import { LayupPanel } from './layup/LayupPanel';
import { LayupRoom } from './layup/LayupRoom';
import { useWindowMode } from './shell/useWindowMode';
import { TitleBar } from './shell/TitleBar';
import { HappeningNow } from './layup/HappeningNow';
import { Invitations } from './requests/Invitations';
import { AddServer } from './onboarding/AddServer';
import { Permissions } from './onboarding/Permissions';
import type {
  IdentityResponse,
  LayupStateResponse,
  PermissionsResponse,
  ServerStateResponse,
} from '../shared/ipc';

/**
 * People are the home screen (SPEC.md §2.1). Connection and identity detail is
 * developer chrome at the bottom, not the main event.
 */
export function App() {
  const [identity, setIdentity] = useState<IdentityResponse | undefined>();
  const [layup, setLayup] = useState<LayupStateResponse | undefined>();
  // Undefined until the privileged side answers: unknown is not "no server",
  // and it is not "a server" either. Nothing is asked of either until it is.
  const [server, setServer] = useState<ServerStateResponse | undefined>();
  // What macOS has agreed to. Undefined until asked - and a screen is never
  // put in somebody's way over an answer that has not arrived.
  const [permissions, setPermissions] = useState<PermissionsResponse | undefined>();
  // Skipping is per-run on purpose: screen recording only takes effect after a
  // restart, so the next launch is exactly when it is worth asking again.
  const [permissionsDismissed, setPermissionsDismissed] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.layup.server.onChanged((next) => {
      if (!cancelled) setServer(next);
    });
    void window.layup.server
      .state()
      .then((next) => {
        if (!cancelled) setServer(next);
      })
      // An unanswerable question leaves the window waiting rather than
      // guessing that there is a server behind it.
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const configured = server?.configured === true;

  useEffect(() => {
    // There is nobody to ask until a server has been added: asking anyway is
    // how a first run ends up talking to a control plane that is not there.
    if (!configured) return;
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
  }, [configured]);

  useEffect(() => {
    // Asked once a server exists, which is the moment somebody has actually
    // committed to using this. Asking on the add-server screen would be a
    // permission sheet in front of a person who has not arrived yet.
    if (!configured) return;
    let cancelled = false;
    void window.layup.permissions
      .all()
      .then((next) => {
        if (!cancelled) setPermissions(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [configured]);

  const inLayup = Boolean(layup?.layup);

  // Anything macOS has not agreed to. Unknown counts as fine: a status we
  // could not read is not a refusal, and must not become a nag.
  const permissionsMissing = permissions
    ? Object.values(permissions).some((entry) => !entry.ok)
    : false;

  // Shown after registration when something is missing, and any time it is
  // asked for from the footer. Never over a live layup: the call wins.
  const askingForPermissions =
    configured && !inLayup && (permissionsOpen || (permissionsMissing && !permissionsDismissed));

  // The directory is a window of its own shape; in a layup the room decides,
  // because only it knows whether a screen has arrived.
  useWindowMode({ inLayup: false, pickerOpen: false, hasIncomingScreen: false });

  // Whichever view this render shows, `<TitleBar />` below is with it always -
  // the drag strip behind the traffic lights is the shell's to give, not any
  // one view's to remember (task 11).
  const view = !server ? (
    // The first paint, before the privileged side has said whether there is a
    // server. Showing the directory here would flash a screen this desktop may
    // have no right to and fire requests at a control plane that is not there.
    <div className="shell shell--waiting" aria-busy="true" />
  ) : !server.configured ? (
    // No server means no people to show and nobody to ask: adding one is the
    // whole application until it is done.
    <AddServer />
  ) : askingForPermissions ? (
    // Before the call rather than during it. Skippable, and the footer link
    // below is how somebody comes back after the restart it asks for.
    <Permissions
      doneLabel={permissionsOpen ? 'Done' : 'Skip for now'}
      onChanged={setPermissions}
      onDone={() => {
        setPermissionsOpen(false);
        setPermissionsDismissed(true);
      }}
    />
  ) : inLayup ? (
    // In a layup, the layup is the whole application. No directory, no
    // Happening Now, no header: those are for deciding who to be with, and
    // that decision is made.
    <div className="shell shell--layup">
      <Invitations currentLayupId={layup?.layup?.id} />
      <LayupRoom layup={layup!} onLeave={() => void window.layup.layup.leave()} />
    </div>
  ) : (
    <div className="shell">
      <header className="shell__header drag">
        <h1>Layup</h1>
        <p className="tagline">People → Layup → Share → Collaborate</p>
      </header>

      <Invitations currentLayupId={layup?.layup?.id} />
      <HappeningNow />
      <PeopleGrid
        selfUserId={identity?.userId}
        onAction={(person, action) => {
          // A click is a social request, never a media start (SPEC.md §4).
          switch (action.kind) {
            case 'start':
              void window.layup.requests.invite(person.userId, {});
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
        <UpdateNotice />
        {/* Screen Recording only takes effect after a restart, so people come
            back to this. It is reachable from every non-call screen. */}
        <button
          type="button"
          className="shell__footer-link"
          onClick={() => setPermissionsOpen(true)}
          data-testid="open-permissions"
        >
          {permissionsMissing ? 'Permissions — something is missing' : 'Permissions'}
        </button>
        <p className="meta">
          {/* The one string a tester reads back to us when something is wrong. */}
          v{BUILD_INFO.version} ({BUILD_INFO.commit}) · protocol v{PROTOCOL_VERSION}
        </p>
      </footer>
    </div>
  );

  return (
    <>
      <TitleBar />
      {view}
    </>
  );
}
