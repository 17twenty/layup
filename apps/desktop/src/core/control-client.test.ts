import { describe, expect, it, vi } from 'vitest';
import { createControlClient } from './control-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const healthyBody = {
  status: 'ok',
  protocolVersion: 1,
  uptimeSeconds: 3,
  build: { version: '0.1.0', goVersion: 'go1.26.4', platform: 'darwin/arm64' },
};

describe('control client probe', () => {
  it('reports connected against a healthy server', async () => {
    let clock = 1000;
    const client = createControlClient({
      baseUrl: 'http://127.0.0.1:8787/',
      fetchImpl: async () => {
        clock += 12;
        return jsonResponse(healthyBody);
      },
      now: () => clock,
    });

    const state = await client.probe();
    expect(state.status).toBe('connected');
    expect(state.serverProtocolVersion).toBe(1);
    expect(state.serverVersion).toBe('0.1.0');
    expect(state.latencyMs).toBe(12);
    expect(state.detail).toBeUndefined();
    expect(client.baseUrl).toBe('http://127.0.0.1:8787');
  });

  it('reports a useful disconnected state when the server is down', async () => {
    const client = createControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: async () => {
        throw new TypeError('fetch failed: ECONNREFUSED');
      },
    });

    const state = await client.probe();
    expect(state.status).toBe('unreachable');
    expect(state.detail).toMatch(/unreachable.*ECONNREFUSED/);
    expect(state.serverProtocolVersion).toBeUndefined();
  });

  it('reports a timeout rather than hanging', async () => {
    const client = createControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      timeoutMs: 25,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });

    const state = await client.probe();
    expect(state.status).toBe('unreachable');
    expect(state.detail).toBe('control service did not answer within 25ms');
  });

  it('distinguishes a protocol mismatch from an outage', async () => {
    const client = createControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: async () => jsonResponse({ ...healthyBody, protocolVersion: 99 }),
    });

    const state = await client.probe();
    expect(state.status).toBe('incompatible');
    expect(state.serverProtocolVersion).toBe(99);
    expect(state.detail).toMatch(/server speaks protocol v99.*desktop speaks v1/);
  });

  it('rejects a health payload it does not recognise', async () => {
    const client = createControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: async () => jsonResponse({ status: 'ok' }),
    });

    const state = await client.probe();
    expect(state.status).toBe('unreachable');
    expect(state.detail).toMatch(/unrecognised health response/);
  });

  it('accepts the fractional uptime the server actually reports', async () => {
    const client = createControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: async () => jsonResponse({ ...healthyBody, uptimeSeconds: 0.0034 }),
    });
    expect((await client.probe()).status).toBe('connected');
  });

  it('surfaces an HTTP error status', async () => {
    const client = createControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: async () => jsonResponse({}, 503),
    });
    expect((await client.probe()).detail).toBe('control service returned HTTP 503');
  });
});

describe('control client versioned API', () => {
  it('sends the protocol version header', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ v: 1, type: 'protocol.info' }),
    );
    const client = createControlClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });
    await client.apiGet('/api/protocol');

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Layup-Protocol-Version']).toBe('1');
  });

  it('reports the server error code on rejection', async () => {
    const client = createControlClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: async () =>
        jsonResponse({ v: 1, type: 'error', payload: { code: 'unsupported_protocol_version' } }, 426),
    });
    await expect(client.apiGet('/api/protocol')).rejects.toThrow(/426.*unsupported_protocol_version/);
  });
});

describe('a refusal from the control plane', () => {
  it('is reported in the words the server used', async () => {
    // "HTTP 403 (forbidden)" is a puzzle; the server already wrote the answer.
    const client = createControlClient({
      baseUrl: 'http://control.test',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            v: 1,
            type: 'error',
            payload: { code: 'forbidden', message: 'ask the current presenter to hand over the screen' },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        )) as unknown as typeof fetch,
    });

    await expect(client.apiPost('/api/layups/lay_1/share')).rejects.toThrow(
      /ask the current presenter to hand over the screen/,
    );
  });

  it('falls back to the status when the server said nothing useful', async () => {
    const client = createControlClient({
      baseUrl: 'http://control.test',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });

    await expect(client.apiGet('/api/layups')).rejects.toThrow(/failed with HTTP 500/);
  });
});

describe('control client identity', () => {
  it('sends the bearer token when it has one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const client = createControlClient({ baseUrl: 'https://layup.blah.au', token: 't0ken', fetchImpl: fetchMock });
    await client.me().catch(() => undefined);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer t0ken');
  });

  it('falls back to the dev header when there is no token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const client = createControlClient({ baseUrl: 'https://layup.blah.au', devUser: 'nick', fetchImpl: fetchMock });
    await client.me().catch(() => undefined);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('x-layup-dev-user')).toBe('nick');
    expect(headers.get('authorization')).toBeNull();
  });
});

/**
 * A link is a key to somebody's call, so where it travels matters as much as
 * what it opens. Nothing here may put one in a URL: Caddy's access-log filter
 * redacts query strings but not paths, and the server moved redemption into
 * the request body for exactly that reason (`httpapi/links.go`).
 */
describe('invitation links', () => {
  it('mints one for a layup you are in', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const client = createControlClient({
      baseUrl: 'https://layup.blah.au',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method });
        return jsonResponse({
          v: 1,
          type: 'layup.link',
          payload: { token: 'tok_abc', expiresAt: '2026-08-18T09:00:00Z' },
        });
      },
    });

    const link = await client.createLink('lay_abc12345');

    expect(link.token).toBe('tok_abc');
    expect(calls[0]).toEqual({
      url: 'https://layup.blah.au/api/layups/lay_abc12345/link',
      method: 'POST',
    });
  });

  it('takes one back out of circulation', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const client = createControlClient({
      baseUrl: 'https://layup.blah.au',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method });
        return jsonResponse({ v: 1, type: 'layup.link.revoked', payload: { layupId: 'lay_abc12345' } });
      },
    });

    await client.revokeLink('lay_abc12345');

    expect(calls[0]).toEqual({
      url: 'https://layup.blah.au/api/layups/lay_abc12345/link',
      method: 'DELETE',
    });
  });

  it('redeems one from the request body, never from the path', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const client = createControlClient({
      baseUrl: 'https://layup.blah.au',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body });
        return jsonResponse({
          v: 1,
          type: 'layup.joined',
          payload: {
            layup: {
              id: 'lay_abc12345',
              organisationId: 'org_devlayup',
              visibility: 'LINK',
              active: true,
              createdAt: '2026-08-17T09:00:00Z',
              hasCreatorAuthority: false,
              participants: [],
            },
            yourMembershipId: 'mem_1',
          },
        });
      },
    });

    await client.joinByLink('tok_abc');

    expect(calls[0]?.url).toBe('https://layup.blah.au/api/links/join');
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ token: 'tok_abc' });
    // The thing that must never be true: the token in the URL.
    expect(calls[0]?.url).not.toContain('tok_abc');
  });
});
