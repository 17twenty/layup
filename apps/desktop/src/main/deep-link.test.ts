import { describe, expect, it } from 'vitest';
import { parseJoinLink } from './deep-link';

describe('parsing a join link', () => {
  it('reads a server and a code out of a join link', () => {
    expect(parseJoinLink('layup://join?server=layup.blah.au&code=LAYUP-7K2M')).toEqual({
      serverUrl: 'https://layup.blah.au',
      code: 'LAYUP-7K2M',
    });
  });

  it('ignores a link that is not ours', () => {
    expect(parseJoinLink('https://example.com/join?code=x')).toBeUndefined();
  });

  it('ignores a link with no code', () => {
    expect(parseJoinLink('layup://join?server=layup.blah.au')).toBeUndefined();
  });

  it('never lets a link choose a non-https server', () => {
    // A link that could point the app at http:// could downgrade the token to
    // cleartext. Refuse it.
    expect(parseJoinLink('layup://join?server=http://evil.example&code=x')).toBeUndefined();
  });

  it('ignores a link with no server', () => {
    expect(parseJoinLink('layup://join?code=LAYUP-7K2M')).toBeUndefined();
  });

  it('ignores garbage that is not a URL at all', () => {
    expect(parseJoinLink('not a url')).toBeUndefined();
  });

  it('keeps an already-https server as it was given', () => {
    expect(parseJoinLink('layup://join?server=https://layup.blah.au&code=LAYUP-C9C76D')).toEqual({
      serverUrl: 'https://layup.blah.au',
      code: 'LAYUP-C9C76D',
    });
  });
});
