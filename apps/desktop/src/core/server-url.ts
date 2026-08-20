/**
 * Turning what somebody typed into an address we can call.
 *
 * Shared by the screen that asks for it and the process that uses it: people
 * type "layup.example", and both sides must agree that this means
 * "https://layup.example" rather than one of them guessing.
 */
export function normaliseServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  // A scheme somebody typed is kept, so http://localhost:8787 still works.
  // Whether http is allowed to *that* host is registerWithServer's rule, not
  // this one's: normalising and permitting are different questions.
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The URL a guest opens: the web client, with the link token in the fragment.
 *
 * The fragment is the point. It is not sent in the HTTP request, so the token
 * never reaches Caddy's access log, never rides along in a `Referer` header,
 * and never sits in a proxy's history - which a token in the path or the query
 * string would do on every single open. The browser client reads it from
 * `location.hash` and posts it in a request body instead (see
 * `httpapi/links.go`, and the same reasoning for `POST /api/links/join`).
 */
export function inviteUrl(serverUrl: string, token: string): string {
  const origin = normaliseServerUrl(serverUrl);
  if (origin === '') throw new Error('no server is configured, so there is nowhere to invite anyone to');
  if (token.trim() === '') throw new Error('the control plane returned an empty link token');
  return `${origin}/j/#${encodeURIComponent(token)}`;
}
