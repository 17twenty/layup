import { normaliseServerUrl } from '../core/server-url';

/** What a join link hands to the Add-server screen: everything but the name. */
export interface JoinLink {
  serverUrl: string;
  code: string;
}

/**
 * Parses `layup://join?server=...&code=...` into what `AddServer` needs to
 * pre-fill, or `undefined` when the link is not ours, is missing a piece, or
 * would point the app at an insecure server.
 *
 * The token this link is standing in for travels over `https` and nowhere
 * else. `registerWithServer` allows `http://` to loopback, for the developer
 * running a control plane on their own machine; a link never gets even that,
 * because nobody typed it - arriving by link is exactly the shape a downgrade
 * attack takes. So a scheme is never upgraded here: a link that names
 * `http://` explicitly is refused outright rather than silently fixed, and a
 * bare hostname goes through `normaliseServerUrl` the same way typed input
 * does.
 */
export function parseJoinLink(url: string): JoinLink | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  // layup://join?... only; anything else is not ours to interpret.
  if (parsed.protocol !== 'layup:' || parsed.host !== 'join') return undefined;

  const code = parsed.searchParams.get('code')?.trim();
  const server = parsed.searchParams.get('server')?.trim();
  if (!code || !server) return undefined;

  const serverUrl = normaliseServerUrl(server);
  if (!/^https:\/\//i.test(serverUrl)) return undefined;

  return { serverUrl, code };
}
