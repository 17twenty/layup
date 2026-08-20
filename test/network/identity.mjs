/**
 * How a network harness gets a credential for the deployed control plane.
 *
 * The server no longer accepts a declared identity from off-host: the
 * X-Layup-Dev-User header is honoured only for a genuinely local caller
 * (services/control/internal/httpapi/auth.go), which through Caddy is never.
 * So a harness running on a laptop has to hold a real bearer token.
 *
 * There are exactly two ways to get one, in this order:
 *
 *   LAYUP_TOKEN      - an existing token, used as-is. Preferred, and what CI
 *                      or a repeated local run should set.
 *   LAYUP_JOIN_CODE  - the server's shared join code, exchanged here for a
 *                      fresh identity via POST /api/register.
 *
 * The token is deliberately *not* cached to disk. A file of long-lived
 * credentials lying around a working copy is precisely the problem this plan
 * exists to remove; a harness run is short, and registering again is cheap.
 */

/**
 * Returns a bearer token for `domain`, registering one if we have no token.
 *
 * @param {object} options
 * @param {string} options.domain           host serving the control plane
 * @param {string|number} options.protocolVersion  value for X-Layup-Protocol-Version
 * @param {string} options.displayName      name to register under, if registering
 * @returns {Promise<string>} a bearer token
 */
export async function resolveToken({ domain, protocolVersion, displayName }) {
  const existing = process.env.LAYUP_TOKEN;
  if (existing) return existing;

  const joinCode = process.env.LAYUP_JOIN_CODE;
  if (!joinCode) {
    throw new Error(
      'no credential: set LAYUP_TOKEN, or LAYUP_JOIN_CODE to self-register. ' +
        "The join code lives on the server in /etc/layup/control.env (LAYUP_JOIN_CODE).",
    );
  }

  const name = process.env.LAYUP_DISPLAY_NAME || displayName;
  const response = await fetch(`https://${domain}/api/register`, {
    method: 'POST',
    headers: {
      'X-Layup-Protocol-Version': String(protocolVersion),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ code: joinCode, displayName: name }),
  });
  if (!response.ok) {
    // Never quote the body back: a rejection is a log line waiting to happen,
    // and the request we just sent contained the join code.
    throw new Error(`POST /api/register returned ${response.status}`);
  }
  const envelope = await response.json();
  const token = envelope.payload?.token;
  if (!token) throw new Error('POST /api/register returned no token');
  console.log(`registered as ${envelope.payload?.user?.displayName ?? name}`);
  return token;
}
