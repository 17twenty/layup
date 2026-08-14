import { describe, expect, it } from 'vitest';
import { createCursorSender } from './cursor-sender';
import type { CursorMove } from '@layup/protocol';

function harness(options: { accept?: boolean } = {}) {
  const sent: CursorMove[] = [];
  let clock = 0;
  const timers: Array<{ at: number; callback: () => void }> = [];
  let accept = options.accept ?? true;

  const sender = createCursorSender({
    membershipId: 'mem_local',
    intervalMs: 16,
    now: () => clock,
    send: (move) => {
      if (!accept) return false;
      sent.push(move);
      return true;
    },
    schedule: (callback, delay) => {
      const handle = { at: clock + delay, callback };
      timers.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (handle) => {
      const index = timers.indexOf(handle as unknown as { at: number; callback: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
  });

  return {
    sender,
    sent,
    setAccept: (value: boolean) => {
      accept = value;
    },
    advance(ms: number) {
      clock += ms;
      for (const timer of timers.splice(0, timers.length)) {
        if (timer.at <= clock) timer.callback();
        else timers.push(timer);
      }
    },
  };
}

const move = (x: number, displayId = 'display-1') => ({
  displayId,
  x,
  y: 100,
  width: 1000,
  height: 1000,
});

describe('cursor sender coalescing', () => {
  it('collapses a burst of movement into one message', () => {
    const h = harness();
    for (let x = 0; x < 500; x += 1) h.sender.move(move(x));

    // Nothing is queued per event: only the newest position survives.
    expect(h.sender.stats().pending).toBe(1);
    h.advance(16);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.x).toBeCloseTo(0.499);
    expect(h.sender.stats()).toMatchObject({ observed: 500, sent: 1, coalesced: 499 });
  });

  it('keeps memory bounded under sustained high-frequency input', () => {
    const h = harness();
    // 10k events across three displays, with no draining at all.
    for (let i = 0; i < 10_000; i += 1) h.sender.move(move(i % 1000, `display-${i % 3}`));

    // One pending position per display, whatever the input rate.
    expect(h.sender.stats().pending).toBe(3);
    expect(h.sender.stats().observed).toBe(10_000);
    expect(h.sender.stats().coalesced).toBe(9_997);
  });

  it('sends the latest position, not the oldest, under backpressure', () => {
    const h = harness({ accept: false });
    h.sender.move(move(10));
    h.advance(16);
    expect(h.sender.stats().refused).toBe(1);

    // While the channel was refusing, the pointer kept moving.
    h.setAccept(true);
    for (let x = 100; x < 200; x += 1) h.sender.move(move(x));
    h.advance(16);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.x).toBeCloseTo(0.199); // the newest, not x=100 or x=10
  });

  it('paces sends rather than emitting one per pointer event', () => {
    const h = harness();
    h.sender.move(move(1));
    h.advance(16);
    expect(h.sent).toHaveLength(1);

    h.sender.move(move(2));
    h.advance(4); // too soon
    expect(h.sent).toHaveLength(1);

    h.advance(12);
    expect(h.sent).toHaveLength(2);
  });

  it('increments the sequence so a receiver can drop stale updates', () => {
    const h = harness();
    for (const x of [1, 2, 3]) {
      h.sender.move(move(x));
      h.advance(16);
    }
    expect(h.sent.map((message) => message.seq)).toEqual([1, 2, 3]);
  });

  it('tracks each display independently', () => {
    const h = harness();
    h.sender.move(move(10, 'display-1'));
    h.sender.move(move(20, 'display-2'));
    h.advance(16);

    expect(h.sent).toHaveLength(2);
    expect(new Set(h.sent.map((message) => message.displayId))).toEqual(
      new Set(['display-1', 'display-2']),
    );
  });

  it('flushes on demand and stops cleanly', () => {
    const h = harness();
    h.sender.move(move(5));
    h.sender.flush();
    expect(h.sent).toHaveLength(1);

    h.sender.move(move(6));
    h.sender.stop();
    h.advance(100);
    expect(h.sent).toHaveLength(1);
    expect(h.sender.stats().pending).toBe(0);
  });

  it('never routes cursor motion through the control plane', async () => {
    // The module may only depend on the protocol types; a control-plane import
    // here would put cursor motion on the Go path (ADR-0002, ADR-0008).
    const { readFileSync } = await import('node:fs');
    // vitest runs with apps/desktop as its root.
    const source = readFileSync('src/core/cursor-sender.ts', 'utf8');
    expect(source).not.toMatch(/control-client|realtime-client|fetch\(/);
  });
});
