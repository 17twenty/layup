import { describe, expect, it, vi } from 'vitest';
import { GuestJoinError, joinAsGuest, tokenFromFragment } from './guest-client';

const layup = {
  id: 'lay_1',
  organisationId: 'org_1',
  title: 'Thursday sync',
  visibility: 'LINK',
  active: true,
  createdAt: '2026-08-17T09:00:00Z',
  hasCreatorAuthority: true,
  participants: [
    {
      membershipId: 'mem_host',
      userId: 'usr_host',
      displayName: 'Nick',
      joinedAt: '2026-08-17T09:00:00Z',
      isCreatorMembership: true,
    },
    {
      membershipId: 'mem_guest',
      userId: 'usr_guest',
      displayName: 'Sam',
      joinedAt: '2026-08-17T09:05:00Z',
      isCreatorMembership: false,
      isGuest: true,
    },
  ],
};

const joined = {
  type: 'guest.joined',
  payload: {
    guestToken: 'gst_secret',
    layup,
    membershipId: 'mem_guest',
    iceServers: [{ urls: ['stun:stun.example:3478'] }],
  },
};

function respond(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('reading the token out of the address bar', () => {
  it('takes it from the fragment, which browsers never send to a server', () => {
    expect(tokenFromFragment('#lnk_abc123')).toBe('lnk_abc123');
    // A fragment survives a copy/paste with the hash already stripped.
    expect(tokenFromFragment('lnk_abc123')).toBe('lnk_abc123');
  });

  it('has no token at all when the fragment is empty', () => {
    // Not "an empty token": nothing. The screen says the link is not valid
    // rather than offering a form that cannot possibly work.
    expect(tokenFromFragment('')).toBeUndefined();
    expect(tokenFromFragment('#')).toBeUndefined();
    expect(tokenFromFragment('#   ')).toBeUndefined();
  });

  it('never reads a token out of the query string', () => {
    // The whole reason the token lives in the fragment is that Caddy's access
    // log keeps paths and query strings. Accepting one from the query string
    // would quietly re-open exactly that.
    const url = new URL('https://layup.example/j/?token=lnk_leaked');
    expect(tokenFromFragment(url.hash)).toBeUndefined();
  });
});

describe('redeeming an invitation link as a guest', () => {
  it('posts the token in the body, never in the URL', async () => {
    const fetchImpl = respond(joined);

    await joinAsGuest({
      serverUrl: 'https://layup.example',
      token: 'lnk_abc123',
      displayName: 'Sam',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://layup.example/api/guest/join');
    expect(url).not.toContain('lnk_abc123');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'lnk_abc123', displayName: 'Sam' });
    expect(init.method).toBe('POST');
  });

  it('returns the token, the layup, which participant you are, and how to connect', async () => {
    const result = await joinAsGuest({
      serverUrl: 'https://layup.example/',
      token: 'lnk_abc123',
      displayName: 'Sam',
      fetchImpl: respond(joined) as unknown as typeof fetch,
    });

    expect(result.guestToken).toBe('gst_secret');
    expect(result.membershipId).toBe('mem_guest');
    expect(result.layup.title).toBe('Thursday sync');
    expect(result.iceServers).toEqual([{ urls: ['stun:stun.example:3478'] }]);
  });

  it("surfaces the server's own refusal rather than inventing one", async () => {
    const body = {
      type: 'error',
      payload: {
        code: 'invalid_link',
        message: 'this invitation link is not valid any more - ask for a new one',
      },
    };

    await expect(
      joinAsGuest({
        serverUrl: 'https://layup.example',
        token: 'lnk_dead',
        displayName: 'Sam',
        fetchImpl: respond(body, 403) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      message: 'this invitation link is not valid any more - ask for a new one',
      code: 'invalid_link',
      status: 403,
    });
  });

  it('refuses a blank name before it ever reaches the network', async () => {
    const fetchImpl = respond(joined);
    await expect(
      joinAsGuest({
        serverUrl: 'https://layup.example',
        token: 'lnk_abc123',
        displayName: '   ',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(GuestJoinError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a response that is not the shape it claims to be', async () => {
    await expect(
      joinAsGuest({
        serverUrl: 'https://layup.example',
        token: 'lnk_abc123',
        displayName: 'Sam',
        fetchImpl: respond({ type: 'guest.joined', payload: { guestToken: 'gst' } }) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
