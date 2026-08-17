import { describe, expect, it, vi } from 'vitest';
import { registerWithServer } from './server';
import { normaliseServerUrl } from '../core/server-url';

const registered = {
  v: 1,
  type: 'identity.registered',
  payload: {
    token: 'lyt_secret',
    user: { id: 'usr_nick', displayName: 'Nick' },
    organisation: { id: 'org_one', name: 'Layup' },
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('adding a server', () => {
  it('turns a bare hostname into an https address', () => {
    expect(normaliseServerUrl(' layup.blah.au ')).toBe('https://layup.blah.au');
    expect(normaliseServerUrl('https://layup.blah.au/')).toBe('https://layup.blah.au');
    // A developer pointing at a local server keeps their scheme.
    expect(normaliseServerUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });

  it('registers and returns a config to store', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, registered));
    const outcome = await registerWithServer({
      serverUrl: 'layup.blah.au',
      code: 'LAYUP-C9C76D',
      displayName: 'Nick',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({
      ok: true,
      config: {
        serverUrl: 'https://layup.blah.au',
        token: 'lyt_secret',
        userId: 'usr_nick',
        displayName: 'Nick',
      },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://layup.blah.au/api/register');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Layup-Protocol-Version']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'LAYUP-C9C76D', displayName: 'Nick' });
  });

  it("repeats the server's own refusal, so the person knows to fix the code", async () => {
    const outcome = await registerWithServer({
      serverUrl: 'https://layup.blah.au',
      code: 'WRONG',
      displayName: 'Nick',
      fetchImpl: (async () =>
        jsonResponse(403, {
          v: 1,
          type: 'error',
          payload: { code: 'forbidden', message: 'that join code is not valid for this server' },
        })) as unknown as typeof fetch,
    });

    expect(outcome).toEqual({
      ok: false,
      message: 'that join code is not valid for this server',
    });
  });

  it('names the host when it cannot be reached', async () => {
    const outcome = await registerWithServer({
      serverUrl: 'https://nowhere.invalid',
      code: 'LAYUP-C9C76D',
      displayName: 'Nick',
      fetchImpl: (async () => {
        throw new Error('getaddrinfo ENOTFOUND nowhere.invalid');
      }) as unknown as typeof fetch,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain('nowhere.invalid');
  });

  it('refuses an answer it does not understand rather than storing half of it', async () => {
    const outcome = await registerWithServer({
      serverUrl: 'https://layup.blah.au',
      code: 'LAYUP-C9C76D',
      displayName: 'Nick',
      fetchImpl: (async () =>
        jsonResponse(200, { v: 1, type: 'identity.registered', payload: { token: 'lyt_secret' } })) as unknown as typeof fetch,
    });

    expect(outcome.ok).toBe(false);
  });

  it('asks for an address rather than calling nothing', async () => {
    const fetchImpl = vi.fn();
    const outcome = await registerWithServer({
      serverUrl: '   ',
      code: 'LAYUP-C9C76D',
      displayName: 'Nick',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ ok: false, message: 'enter the address of a Layup server' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
