import { describe, expect, it } from 'vitest';
import { createRealtimeSupervisor } from './realtime';
import type { Logger } from './logging';
import type { RealtimeSocket } from '../core/realtime-client';

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  with: () => silent,
};

function fakeSocket(): RealtimeSocket {
  return { send: () => {}, close: () => {}, onopen: null, onclose: null, onerror: null, onmessage: null };
}

describe('realtime supervisor', () => {
  it('opens the socket against the server configured at the time, not at startup', () => {
    const urls: string[] = [];
    let serverUrl = 'http://127.0.0.1:8787';
    let token: string | undefined = undefined;

    const supervisor = createRealtimeSupervisor({
      baseUrl: () => serverUrl,
      token: () => token,
      devUser: 'nick',
      log: silent,
      socketFactory: (url) => {
        urls.push(url);
        return fakeSocket();
      },
    });

    supervisor.start();

    // Somebody adds a server: the next connection must go there, and carry the
    // token rather than the development handle.
    serverUrl = 'https://layup.blah.au';
    token = 'lyt_secret';
    supervisor.stop();
    supervisor.start();

    expect(urls[0]).toContain('ws://127.0.0.1:8787/api/realtime');
    expect(urls[0]).toContain('devUser=nick');
    expect(urls[1]).toContain('wss://layup.blah.au/api/realtime');
    expect(urls[1]).toContain('token=lyt_secret');
    expect(urls[1]).not.toContain('devUser');
  });
});
