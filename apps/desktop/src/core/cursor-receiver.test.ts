import { describe, expect, it } from 'vitest';
import { createCursorReceiver } from './cursor-receiver';
import type { CursorMove } from '@layup/protocol';

const move = (overrides: Partial<CursorMove> = {}): CursorMove => ({
  type: 'cursor.move',
  membershipId: 'mem_a',
  displayId: 'display-1',
  x: 0.5,
  y: 0.5,
  seq: 1,
  ...overrides,
});

function harness(options: { smoothingMs?: number; staleAfterMs?: number } = {}) {
  let clock = 0;
  const receiver = createCursorReceiver({
    smoothingMs: options.smoothingMs ?? 16,
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
    now: () => clock,
  });
  return { receiver, advance: (ms: number) => (clock += ms) };
}

describe('remote cursor receiver', () => {
  it('places a newly seen cursor where it is, not at the origin', () => {
    const h = harness();
    h.receiver.apply(move({ x: 0.8, y: 0.2 }));

    const [cursor] = h.receiver.sample();
    expect(cursor).toMatchObject({ x: 0.8, y: 0.2, membershipId: 'mem_a', displayId: 'display-1' });
  });

  it('interpolates towards the newest packet and converges on it', () => {
    const h = harness({ smoothingMs: 16 });
    h.receiver.apply(move({ x: 0, y: 0, seq: 1 }));
    h.receiver.sample();

    h.receiver.apply(move({ x: 1, y: 1, seq: 2 }));
    h.advance(8); // half an interval
    const midway = h.receiver.sample()[0]!;
    expect(midway.x).toBeGreaterThan(0);
    expect(midway.x).toBeLessThan(1);

    h.advance(8); // a full interval since the packet
    const settled = h.receiver.sample()[0]!;
    // Never trails the truth: by one interval it is on the target.
    expect(settled.x).toBeCloseTo(1, 5);
    expect(settled.y).toBeCloseTo(1, 5);
  });

  it('drops a stale packet that overtook a newer one', () => {
    const h = harness();
    expect(h.receiver.apply(move({ x: 0.9, seq: 5 }))).toBe(true);
    expect(h.receiver.apply(move({ x: 0.1, seq: 4 }))).toBe(false);

    h.advance(100);
    expect(h.receiver.sample()[0]?.targetX).toBe(0.9);
  });

  it('renders independently of how often packets arrive', () => {
    const h = harness();
    h.receiver.apply(move({ x: 0.25, y: 0.75 }));

    // Sampling far more often than packets arrive is fine and stable.
    for (let i = 0; i < 10; i += 1) {
      h.advance(4);
      expect(h.receiver.sample()).toHaveLength(1);
    }
    const cursor = h.receiver.sample()[0]!;
    expect(cursor.x).toBeCloseTo(0.25, 5);
    expect(cursor.y).toBeCloseTo(0.75, 5);
  });

  it('keeps several participants apart', () => {
    const h = harness();
    h.receiver.apply(move({ membershipId: 'mem_a', x: 0.1 }));
    h.receiver.apply(move({ membershipId: 'mem_b', x: 0.9 }));

    const sample = h.receiver.sample();
    expect(sample).toHaveLength(2);
    expect(sample.find((c) => c.membershipId === 'mem_a')?.x).toBeCloseTo(0.1);
    expect(sample.find((c) => c.membershipId === 'mem_b')?.x).toBeCloseTo(0.9);
  });

  it('removes a cursor when its membership goes, and forgets its sequence', () => {
    const h = harness();
    h.receiver.apply(move({ seq: 99 }));
    h.receiver.remove('mem_a');
    expect(h.receiver.sample()).toHaveLength(0);

    // A fresh membership reusing the id must not inherit the old sequence.
    expect(h.receiver.apply(move({ seq: 1, x: 0.3 }))).toBe(true);
    expect(h.receiver.sample()[0]?.targetX).toBe(0.3);
  });

  it('drops a cursor that has gone quiet', () => {
    const h = harness({ staleAfterMs: 1000 });
    h.receiver.apply(move());
    h.advance(1001);
    expect(h.receiver.sample()).toHaveLength(0);
  });
});
