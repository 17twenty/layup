import { beforeEach, describe, expect, it } from 'vitest';
import { createInputLeases, type InputLeases, type LeaseEndCause } from './input-lease';

const KARL = 'm-karl';
const SAM = 'm-sam';

let clock = 0;
let ended: Array<{ membershipId: string; cause: LeaseEndCause }>;
let leases: InputLeases;

beforeEach(() => {
  clock = 1_000;
  ended = [];
  leases = createInputLeases({
    idleTimeoutMs: 2_000,
    now: () => clock,
    onReleased: (lease, cause) => ended.push({ membershipId: lease.membershipId, cause }),
  });
});

describe('pointer drag lease', () => {
  it('gives the drag to whoever started it', () => {
    expect(leases.acquire('pointer', KARL)).toBe(true);
    expect(leases.holder('pointer')?.membershipId).toBe(KARL);

    // Two people dragging at once do not make two drags; they make one object
    // thrown across the screen.
    expect(leases.acquire('pointer', SAM)).toBe(false);
    expect(leases.mayAct('pointer', SAM)).toBe(false);
    // The holder carries on freely.
    expect(leases.mayAct('pointer', KARL)).toBe(true);
  });

  it('lets anybody act when nobody is dragging', () => {
    expect(leases.mayAct('pointer', SAM)).toBe(true);
    expect(leases.holder('pointer')).toBeUndefined();
  });

  it('releases on mouse-up and hands over cleanly', () => {
    leases.acquire('pointer', KARL);
    expect(leases.release('pointer', KARL)).toBe(true);
    expect(ended).toEqual([{ membershipId: KARL, cause: 'released' }]);

    expect(leases.acquire('pointer', SAM)).toBe(true);
  });

  it('will not let somebody else release a lease they do not hold', () => {
    leases.acquire('pointer', KARL);
    expect(leases.release('pointer', SAM)).toBe(false);
    expect(leases.holder('pointer')?.membershipId).toBe(KARL);
  });

  it('keeps a live drag alive while it is moving', () => {
    leases.acquire('pointer', KARL);
    // A slow drag across a big screen must not time out halfway.
    for (let step = 0; step < 10; step += 1) {
      clock += 1_500;
      leases.touch('pointer', KARL);
      expect(leases.expire()).toBe(0);
    }
    expect(leases.holder('pointer')?.membershipId).toBe(KARL);
  });

  it('expires a lease that goes quiet', () => {
    leases.acquire('pointer', KARL);
    clock += 2_000;

    // A peer that stops sending without disconnecting looks exactly like one
    // that vanished, so the lease must not be held forever.
    expect(leases.expire()).toBe(1);
    expect(ended).toEqual([{ membershipId: KARL, cause: 'timeout' }]);
    expect(leases.acquire('pointer', SAM)).toBe(true);
  });

  it('lets the next person take a stale lease even before it is swept', () => {
    leases.acquire('pointer', KARL);
    clock += 5_000;

    expect(leases.mayAct('pointer', SAM)).toBe(true);
    expect(leases.acquire('pointer', SAM)).toBe(true);
    expect(ended).toEqual([{ membershipId: KARL, cause: 'timeout' }]);
    expect(leases.holder('pointer')?.membershipId).toBe(SAM);
  });

  it('releases everything a membership holds when it disconnects', () => {
    leases.acquire('pointer', KARL);
    leases.acquire('keyboard', KARL);
    leases.acquire('pointer', SAM); // refused; Karl holds it

    expect(leases.releaseAll(KARL)).toBe(2);
    expect(ended.map((entry) => entry.cause)).toEqual(['disconnect', 'disconnect']);
    expect(leases.holder('pointer')).toBeUndefined();
    expect(leases.holder('keyboard')).toBeUndefined();
  });

  it('renewing your own lease does not restart it', () => {
    leases.acquire('pointer', KARL);
    const acquiredAt = leases.holder('pointer')?.acquiredAtMs;
    clock += 500;
    expect(leases.acquire('pointer', KARL)).toBe(true);
    expect(leases.holder('pointer')?.acquiredAtMs).toBe(acquiredAt);
    expect(leases.holder('pointer')?.touchedAtMs).toBe(clock);
  });

  it('holds pointer and keyboard separately', () => {
    leases.acquire('pointer', KARL);
    // Somebody dragging must not also lock the keyboard: they are different
    // scopes, granted separately.
    expect(leases.acquire('keyboard', SAM)).toBe(true);
    expect(leases.mayAct('keyboard', SAM)).toBe(true);
    expect(leases.mayAct('pointer', SAM)).toBe(false);
  });
});
