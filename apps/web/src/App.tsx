/**
 * The web guest client's root component.
 *
 * There is exactly one route worth the name: `/j/#<token>`. The token is in
 * the fragment because a browser never sends a fragment to a server, so the
 * one credential that opens somebody else's call cannot end up in an access
 * log (guest-client.ts).
 *
 * The control plane is same-origin: Caddy serves this bundle and proxies
 * `/api` to the Go service, so there is nothing for a guest to type or
 * configure. `serverUrl` is a prop only so tests and a `vite dev` session can
 * point somewhere else.
 */
import { useState } from 'react';
import { GuestRoom } from './GuestRoom';
import { Join } from './Join';
import { useGuestRoom } from './useGuestRoom';
import { tokenFromFragment, type GuestJoinResult } from './guest-client';

export interface AppProps {
  serverUrl?: string;
  /** The URL fragment, overridable for tests. */
  hash?: string;
}

export function App({ serverUrl, hash }: AppProps = {}) {
  const [joined, setJoined] = useState<GuestJoinResult | undefined>(undefined);
  // Read once, on the first render: the token is spent the moment it is
  // redeemed, and a fragment that changes underneath a live call means
  // nothing.
  const [token] = useState(() => tokenFromFragment(hash ?? window.location.hash));
  const origin = serverUrl ?? window.location.origin;

  // Two screens and one transition between them. The room is a separate
  // component rather than a branch here because `useGuestRoom` opens devices
  // and a peer connection the moment it runs, and that must not happen until
  // somebody has actually joined.
  if (joined) return <Room serverUrl={origin} guest={joined} />;

  return (
    <Join serverUrl={origin} {...(token ? { token } : {})} onJoined={setJoined} />
  );
}

function Room({ serverUrl, guest }: { serverUrl: string; guest: GuestJoinResult }) {
  return <GuestRoom room={useGuestRoom({ serverUrl, guest })} />;
}
