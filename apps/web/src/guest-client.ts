/**
 * Redeeming an invitation link, from a browser.
 *
 * This is the guest's entire relationship with the control plane before the
 * call exists: one POST, and everything needed to connect comes back in the
 * answer (`httpapi/guest_join.go`).
 *
 * Two things here are deliberate and easy to undo by accident:
 *
 *   - the link token travels in the **body**, never in the URL. Caddy's
 *     access-log filter redacts query strings but keeps paths, so a token
 *     anywhere in the URL is a token written to disk in cleartext on every
 *     join. `tokenFromFragment` is the other half of that promise: the token
 *     reaches this page in the URL *fragment*, which a browser never sends to
 *     a server at all;
 *   - this is `POST /api/guest/join`, which is **not** `POST /api/links/join`.
 *     The latter is how somebody with an account joins by link, and it needs
 *     an identity this visitor does not have.
 */
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  isArrayOf,
  isObject,
  isString,
  optional,
} from '@layup/protocol';
import { layupShape, type Layup } from '@core/control-client';

/** Where a link is redeemed. Not `/api/links/join`; see the file comment. */
export const GUEST_JOIN_PATH = '/api/guest/join';

/** The route a guest link lands on, for building and recognising links. */
export const GUEST_JOIN_ROUTE = '/j/';

export interface GuestJoinResult {
  /** Scoped to this one layup, and to this one visitor (guest_auth.go). */
  guestToken: string;
  layup: Layup;
  /** Which participant in `layup.participants` is you. */
  membershipId: string;
  iceServers: RTCIceServer[];
}

/**
 * A refusal from the server, carrying the server's own words.
 *
 * The server answers every way a link can fail with one message on purpose -
 * unknown, revoked, expired, ended - so a stranger with a guessed token
 * learns nothing. Inventing our own text here would either leak more than
 * that or contradict it, so we show what we were told.
 */
export class GuestJoinError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, options: { status: number; code?: string } = { status: 0 }) {
    super(message);
    this.name = 'GuestJoinError';
    this.status = options.status;
    this.code = options.code;
  }
}

const iceServerShape = isObject({
  // `urls` is one or many in the browser API; the server sends an array.
  urls: isArrayOf(isString, { max: 16 }),
  username: optional(isString),
  credential: optional(isString),
});

const guestJoinShape = isObject({
  guestToken: isString,
  layup: layupShape,
  membershipId: isString,
  iceServers: isArrayOf(iceServerShape, { max: 16 }),
});

/**
 * The token this page was opened with, if there is one.
 *
 * Takes `location.hash` and nothing else. A caller that reaches for
 * `location.search` instead has re-introduced the logging problem this whole
 * arrangement exists to avoid, so there is no query-string path here to reach
 * for by mistake.
 *
 * Absent, empty or blank all give `undefined` rather than an empty string: the
 * join screen shows "this link is not valid" for that, instead of a form that
 * could never have worked.
 */
export function tokenFromFragment(hash: string | undefined): string | undefined {
  if (!hash) return undefined;
  const token = decodeURIComponent(hash.startsWith('#') ? hash.slice(1) : hash).trim();
  return token === '' ? undefined : token;
}

export interface JoinAsGuestOptions {
  /** The control plane's origin, e.g. `https://layup.example`. */
  serverUrl: string;
  token: string;
  displayName: string;
  fetchImpl?: typeof fetch;
}

export async function joinAsGuest(options: JoinAsGuestOptions): Promise<GuestJoinResult> {
  const displayName = options.displayName.trim();
  if (displayName === '') {
    // The server says this too, and says it better; this is only so a blank
    // form never becomes a request, and never a seat in somebody's call.
    throw new GuestJoinError('tell the others what to call you', { status: 0 });
  }

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.serverUrl.replace(/\/+$/, '');

  const response = await doFetch(`${baseUrl}${GUEST_JOIN_PATH}`, {
    method: 'POST',
    headers: {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    // The token is here, and only here.
    body: JSON.stringify({ token: options.token, displayName }),
  });

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new GuestJoinError(errorMessage(body) ?? `the server refused this link (HTTP ${response.status})`, {
      status: response.status,
      ...(errorCode(body) ? { code: errorCode(body) as string } : {}),
    });
  }

  // Validated rather than cast: this response decides who we are for the rest
  // of the call, and a half-formed one should fail here, loudly.
  return guestJoinShape(payloadOf(body), 'guest.joined') as GuestJoinResult;
}

function payloadOf(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  return (body as { payload?: unknown }).payload;
}

function errorMessage(body: unknown): string | undefined {
  const payload = payloadOf(body);
  if (typeof payload !== 'object' || payload === null) return undefined;
  const message = (payload as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() !== '' ? message : undefined;
}

function errorCode(body: unknown): string | undefined {
  const payload = payloadOf(body);
  if (typeof payload !== 'object' || payload === null) return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
