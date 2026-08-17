import { describe, expect, it } from 'vitest';
import { inviteUrl, normaliseServerUrl } from './server-url';

describe('what somebody typed', () => {
  it('becomes an address we can call', () => {
    expect(normaliseServerUrl('layup.example')).toBe('https://layup.example');
    expect(normaliseServerUrl('https://layup.example/')).toBe('https://layup.example');
    expect(normaliseServerUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normaliseServerUrl('   ')).toBe('');
  });
});

describe('the invitation URL', () => {
  it('carries the token in the fragment, so no server ever sees it', () => {
    // A fragment is not sent in the HTTP request. Put the token in the path or
    // the query and every hop - Caddy's access log, a proxy, a Referer header
    // on the next click - has a working key to somebody's call written down in
    // cleartext. The browser client reads it from location.hash instead.
    expect(inviteUrl('https://layup.blah.au', 'abc123')).toBe('https://layup.blah.au/j/#abc123');
  });

  it('accepts an origin in whatever shape it was configured', () => {
    expect(inviteUrl('layup.blah.au', 'abc123')).toBe('https://layup.blah.au/j/#abc123');
    expect(inviteUrl('https://layup.blah.au/', 'abc123')).toBe('https://layup.blah.au/j/#abc123');
    expect(inviteUrl('http://localhost:8787', 'abc123')).toBe('http://localhost:8787/j/#abc123');
  });

  it('encodes a token rather than trusting it to be URL-safe', () => {
    expect(inviteUrl('https://layup.blah.au', 'a+b/c=')).toBe('https://layup.blah.au/j/#a%2Bb%2Fc%3D');
  });

  it('refuses to build a link out of nothing', () => {
    expect(() => inviteUrl('', 'abc123')).toThrow(/server/i);
    expect(() => inviteUrl('https://layup.blah.au', '')).toThrow(/token/i);
  });
});
