import { PROTOCOL_HEADER, PROTOCOL_VERSION, ValidationError, isObject, isString, optional } from '@layup/protocol';
import type { DesktopConfig } from './config';
import { normaliseServerUrl } from '../core/server-url';

/**
 * Joining a server, from the outside.
 *
 * This is the one request the desktop makes before it has any identity, so it
 * cannot go through the control client: there is no token yet, and the point
 * of the call is to get one. It lives in the main process because the token it
 * returns must never cross the preload bridge (ADR-0006).
 */

/** A refusal carries the server's own sentence, not one of ours. */
export type RegisterOutcome =
  | { ok: true; config: DesktopConfig }
  | { ok: false; message: string };

export interface RegisterOptions {
  /** Absolute http(s) address of the server, e.g. https://layup.example. */
  serverUrl: string;
  code: string;
  displayName: string;
  fetchImpl?: typeof fetch;
  /** Registration is a cold-start request; it is given longer than a poll. */
  timeoutMs?: number;
}

/** Mirrors RegisterResponse in services/control/internal/httpapi/register.go. */
const registeredShape = isObject({
  token: isString,
  user: isObject({
    id: isString,
    displayName: isString,
    avatarUrl: optional(isString),
    statusMessage: optional(isString),
  }),
  organisation: isObject({ id: isString, name: isString }),
});

/** Hosts that never leave this machine, where http is the developer's loop. */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Reads the `message` out of an error envelope, when the server sent one. */
function serverMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const payload = (body as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const message = (payload as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() !== '' ? message : undefined;
}

/**
 * Registers this desktop with a server using its shared join code.
 *
 * Every failure is an outcome rather than an exception: a wrong join code and
 * an unreachable host are both things the person who typed them can fix, and
 * both are shown to them in the server's words where the server has any.
 */
export async function registerWithServer(options: RegisterOptions): Promise<RegisterOutcome> {
  const serverUrl = normaliseServerUrl(options.serverUrl);
  if (serverUrl === '') return { ok: false, message: 'enter the address of a Layup server' };

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return { ok: false, message: `"${options.serverUrl.trim()}" is not a server address` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: `"${options.serverUrl.trim()}" is not a server address` };
  }
  // A token sent over http is a token anyone on the path can read, and it is
  // written to config, so one typed scheme would keep leaking for as long as
  // that server stays added. http survives for the machine you are on and
  // nowhere else - the same rule a join link already enforces.
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    return {
      ok: false,
      message: `${parsed.host} must be https - a token sent over http can be read by anyone on the way`,
    };
  }

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(`${serverUrl}/api/register`, {
      method: 'POST',
      headers: {
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: options.code.trim(), displayName: options.displayName.trim() }),
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      return { ok: false, message: `${parsed.host} did not answer within ${timeoutMs}ms` };
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, message: `could not reach ${parsed.host} (${reason})` };
  } finally {
    clearTimeout(timer);
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    // The server's own words first: "that join code is not valid for this
    // server" is an instruction, where "something went wrong" is a dead end.
    return {
      ok: false,
      message: serverMessage(body) ?? `${parsed.host} refused the registration (HTTP ${response.status})`,
    };
  }

  let payload: ReturnType<typeof registeredShape>;
  try {
    payload = registeredShape((body as { payload?: unknown } | undefined)?.payload, 'identity.registered');
  } catch (cause) {
    const detail = cause instanceof ValidationError ? cause.message : String(cause);
    return { ok: false, message: `${parsed.host} answered with something this desktop does not understand (${detail})` };
  }

  return {
    ok: true,
    config: {
      serverUrl,
      token: payload.token,
      userId: payload.user.id,
      displayName: payload.user.displayName,
    },
  };
}
