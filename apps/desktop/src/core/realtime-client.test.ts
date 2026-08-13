import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope } from '@layup/protocol';
import { createRealtimeClient, realtimeUrl, type RealtimeSocket } from './realtime-client';

class FakeSocket implements RealtimeSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    if (this.closed) throw new Error('socket is closed');
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }

  open() {
    this.onopen?.();
  }

  deliver(message: unknown) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  hello(overrides: Record<string, unknown> = {}) {
    this.open();
    this.deliver(
      envelope('hello.ok', {
        connectionId: 'conn-1',
        userId: 'usr_devkarlx',
        organisationId: 'org_devlayup',
        protocolVersion: 1,
        heartbeatIntervalMs: 1000,
        ...overrides,
      }),
    );
  }

  serverClose(reason = 'server went away') {
    this.closed = { code: 1006, reason };
    this.onclose?.({ code: 1006, reason });
  }
}

function client(options: Partial<Parameters<typeof createRealtimeClient>[0]> = {}) {
  return createRealtimeClient({
    baseUrl: 'http://127.0.0.1:8787',
    devUser: 'karl',
    socketFactory: (url) => new FakeSocket(url),
    reconnectBaseMs: 100,
    reconnectMaxMs: 400,
    ...options,
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('realtime client', () => {
  it('builds a ws URL carrying the protocol version and identity', () => {
    expect(realtimeUrl('http://127.0.0.1:8787/', 'karl')).toBe(
      'ws://127.0.0.1:8787/api/realtime?v=1&devUser=karl',
    );
    expect(realtimeUrl('https://layup.example', 'nick')).toBe(
      'wss://layup.example/api/realtime?v=1&devUser=nick',
    );
  });

  it('reports connected once the server says hello', () => {
    const c = client();
    c.start();
    expect(c.state().status).toBe('connecting');

    FakeSocket.instances[0]!.hello();

    expect(c.state()).toMatchObject({
      status: 'connected',
      connectionId: 'conn-1',
      userId: 'usr_devkarlx',
      organisationId: 'org_devlayup',
      attempt: 0,
    });
    c.stop();
  });

  it('acknowledges heartbeats', () => {
    const c = client();
    c.start();
    const socket = FakeSocket.instances[0]!;
    socket.hello();
    socket.deliver(envelope('heartbeat', { seq: 7 }));

    const ack = socket.sent.map((line) => JSON.parse(line)).find((m) => m.type === 'heartbeat.ack');
    expect(ack).toMatchObject({ v: 1, type: 'heartbeat.ack', payload: { seq: 7 } });
    c.stop();
  });

  it('treats a missing heartbeat as a broken connection and reconnects', () => {
    const c = client();
    c.start();
    const first = FakeSocket.instances[0]!;
    first.hello(); // heartbeatIntervalMs: 1000, factor 3 -> 3000ms watchdog

    vi.advanceTimersByTime(2999);
    expect(c.state().status).toBe('connected');

    vi.advanceTimersByTime(2);
    expect(c.state().status).toBe('reconnecting');
    expect(first.closed).toBeTruthy();

    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1]!.hello({ connectionId: 'conn-2' });
    expect(c.state()).toMatchObject({ status: 'connected', connectionId: 'conn-2', attempt: 0 });
    c.stop();
  });

  it('reconnects with backoff when the socket closes', () => {
    const c = client();
    c.start();
    FakeSocket.instances[0]!.serverClose();
    expect(c.state()).toMatchObject({ status: 'reconnecting', attempt: 1 });

    vi.advanceTimersByTime(75); // backoff 100 -> 50..100, random 0.5 -> 75
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1]!.serverClose();
    expect(c.state().attempt).toBe(2);
    vi.advanceTimersByTime(74);
    expect(FakeSocket.instances).toHaveLength(2); // still waiting: longer backoff
    vi.advanceTimersByTime(76);
    expect(FakeSocket.instances).toHaveLength(3);
    c.stop();
  });

  it('does not duplicate subscriptions across reconnects', () => {
    const c = client();
    const seen: string[] = [];
    const unsubscribe = c.on('presence.update', (message) => {
      seen.push(String((message.payload as { userId: string }).userId));
    });

    c.start();
    FakeSocket.instances[0]!.hello();
    FakeSocket.instances[0]!.deliver(envelope('presence.update', { userId: 'a' }));

    FakeSocket.instances[0]!.serverClose();
    vi.advanceTimersByTime(200);
    FakeSocket.instances[1]!.hello({ connectionId: 'conn-2' });
    FakeSocket.instances[1]!.deliver(envelope('presence.update', { userId: 'b' }));

    // One handler, one delivery each - not two after the reconnect.
    expect(seen).toEqual(['a', 'b']);

    unsubscribe();
    FakeSocket.instances[1]!.deliver(envelope('presence.update', { userId: 'c' }));
    expect(seen).toEqual(['a', 'b']);
    c.stop();
  });

  it('rejects malformed events without dropping the connection', () => {
    const warn = vi.fn();
    const c = client({ log: { debug: vi.fn(), info: vi.fn(), warn } });
    const seen: unknown[] = [];
    c.on('presence.update', (message) => seen.push(message.payload));

    c.start();
    const socket = FakeSocket.instances[0]!;
    socket.hello();

    socket.deliver('not json');
    socket.deliver('{"type":"presence.update"}'); // no version
    socket.deliver('{"v":99,"type":"presence.update"}'); // unsupported version
    expect(seen).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(c.state().status).toBe('connected');

    socket.deliver(envelope('presence.update', { userId: 'a' }));
    expect(seen).toHaveLength(1);
    c.stop();
  });

  it('survives a throwing subscriber', () => {
    const c = client();
    const good = vi.fn();
    c.on('presence.update', () => {
      throw new Error('subscriber exploded');
    });
    c.on('presence.update', good);

    c.start();
    FakeSocket.instances[0]!.hello();
    FakeSocket.instances[0]!.deliver(envelope('presence.update', { userId: 'a' }));

    expect(good).toHaveBeenCalledTimes(1);
    expect(c.state().status).toBe('connected');
    c.stop();
  });

  it('stops cleanly and does not reconnect afterwards', () => {
    const c = client();
    c.start();
    const socket = FakeSocket.instances[0]!;
    socket.hello();

    c.stop();
    expect(c.state().status).toBe('stopped');
    expect(socket.closed).toMatchObject({ code: 1000 });

    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('notifies status subscribers and lets them unsubscribe', () => {
    const c = client();
    const seen: string[] = [];
    const unsubscribe = c.onStatus((state) => seen.push(state.status));

    c.start();
    FakeSocket.instances[0]!.hello();
    expect(seen).toContain('connecting');
    expect(seen).toContain('connected');

    unsubscribe();
    const before = seen.length;
    c.stop();
    expect(seen).toHaveLength(before);
  });
});
