import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_ANNOTATION,
  CHANNEL_CONFIG,
  CHANNEL_CURSOR,
  CHANNEL_INPUT,
  CHANNEL_NAMES,
  createDataChannels,
} from './data-channels';

class FakeChannel {
  readyState: RTCDataChannelState = 'open';
  sent: string[] = [];
  closed = false;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(
    readonly label: string,
    readonly init: RTCDataChannelInit,
  ) {}

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 'closed';
  }
  deliver(raw: string) {
    this.onmessage?.({ data: raw } as MessageEvent);
  }
}

function harness() {
  const created = new Map<string, FakeChannel>();
  const set = createDataChannels({
    createDataChannel: (label, init) => {
      const channel = new FakeChannel(label, init);
      created.set(label, channel);
      return channel as unknown as RTCDataChannel;
    },
  });
  return { set, created };
}

describe('semantic data channels', () => {
  it('opens all three channels with the right delivery semantics', () => {
    const h = harness();
    expect([...h.created.keys()]).toEqual([...CHANNEL_NAMES]);

    // Cursor motion: unordered and unreliable - stale is worse than lost.
    expect(h.created.get(CHANNEL_CURSOR)?.init).toMatchObject({ ordered: false, maxRetransmits: 0 });
    // Drawing: loss-tolerant but with a little repair.
    expect(h.created.get(CHANNEL_ANNOTATION)?.init).toMatchObject({ ordered: false, maxRetransmits: 2 });
    // Destructive input: ordered and reliable, with no retransmit limit.
    expect(h.created.get(CHANNEL_INPUT)?.init.ordered).toBe(true);
    expect(h.created.get(CHANNEL_INPUT)?.init.maxRetransmits).toBeUndefined();
  });

  it('never puts cursor motion on a reliable queue', () => {
    // The one rule ADR-0008 exists to protect.
    expect(CHANNEL_CONFIG[CHANNEL_CURSOR].maxRetransmits).toBe(0);
    expect(CHANNEL_CONFIG[CHANNEL_CURSOR].ordered).toBe(false);
    expect(CHANNEL_CONFIG[CHANNEL_INPUT].maxRetransmits).toBeUndefined();
  });

  it('uses negotiated channels so both sides agree without an extra round trip', () => {
    const h = harness();
    const ids = [...h.created.values()].map((channel) => channel.init.id);
    expect(new Set(ids).size).toBe(3);
    expect([...h.created.values()].every((channel) => channel.init.negotiated)).toBe(true);
  });

  it('routes messages to the subscribers of that channel only', () => {
    const h = harness();
    const cursor = vi.fn();
    const input = vi.fn();
    h.set.on(CHANNEL_CURSOR, cursor);
    h.set.on(CHANNEL_INPUT, input);

    h.created.get(CHANNEL_CURSOR)?.deliver(JSON.stringify({ x: 0.5, y: 0.25 }));

    expect(cursor).toHaveBeenCalledWith({ x: 0.5, y: 0.25 }, CHANNEL_CURSOR);
    expect(input).not.toHaveBeenCalled();
  });

  it('drops junk without breaking the channel', () => {
    const h = harness();
    const handler = vi.fn();
    h.set.on(CHANNEL_CURSOR, handler);

    h.created.get(CHANNEL_CURSOR)?.deliver('not json');
    expect(handler).not.toHaveBeenCalled();

    h.created.get(CHANNEL_CURSOR)?.deliver(JSON.stringify({ x: 1 }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing subscriber', () => {
    const h = harness();
    const good = vi.fn();
    h.set.on(CHANNEL_INPUT, () => {
      throw new Error('subscriber exploded');
    });
    h.set.on(CHANNEL_INPUT, good);

    h.created.get(CHANNEL_INPUT)?.deliver(JSON.stringify({ type: 'pointer.click' }));
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('counts messages dropped because a channel was not open', () => {
    const h = harness();
    const channel = h.created.get(CHANNEL_CURSOR)!;
    channel.readyState = 'connecting';

    expect(h.set.send(CHANNEL_CURSOR, { x: 0.1, y: 0.1 })).toBe(false);
    expect(h.set.isOpen(CHANNEL_CURSOR)).toBe(false);
    expect(h.set.dropped(CHANNEL_CURSOR)).toBe(1);
    expect(channel.sent).toHaveLength(0);

    channel.readyState = 'open';
    expect(h.set.send(CHANNEL_CURSOR, { x: 0.2, y: 0.2 })).toBe(true);
    expect(JSON.parse(channel.sent[0]!)).toEqual({ x: 0.2, y: 0.2 });
  });

  it('unsubscribes and closes cleanly', () => {
    const h = harness();
    const handler = vi.fn();
    const off = h.set.on(CHANNEL_ANNOTATION, handler);
    off();
    h.created.get(CHANNEL_ANNOTATION)?.deliver(JSON.stringify({ type: 'stroke.begin' }));
    expect(handler).not.toHaveBeenCalled();

    h.set.close();
    expect([...h.created.values()].every((channel) => channel.closed)).toBe(true);
  });
});
