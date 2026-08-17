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
import { Join } from './Join';
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

  if (joined) {
    return (
      <main>
        <h1>{joined.layup.title ?? 'Layup'}</h1>
        <p>You are in. The call itself is Task 9.</p>
      </main>
    );
  }

  return (
    <Join
      serverUrl={serverUrl ?? window.location.origin}
      {...(token ? { token } : {})}
      onJoined={setJoined}
    />
  );
}
