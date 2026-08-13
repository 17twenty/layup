import { describe, expect, it, vi } from 'vitest';
import { createAttentionController, type AttentionSurface } from './attention';
import type { RequestsState } from './requests';
import type { JoinRequest } from '../core/control-client';

const request = (id: string, fromName: string): JoinRequest => ({
  id,
  type: 'INVITE_USER_TO_NEW_LAYUP',
  state: 'PENDING',
  fromUserId: 'usr_devnickx',
  fromName,
  createdAt: '2026-08-13T09:00:00Z',
  expiresAt: '2026-08-13T09:01:00Z',
});

function harness() {
  const surface: AttentionSurface = {
    setBadge: vi.fn(),
    setTooltip: vi.fn(),
    alert: vi.fn(),
  };
  return { surface, controller: createAttentionController({ surface }) };
}

const state = (incoming: JoinRequest[]): RequestsState => ({ incoming, outgoing: [] });

describe('menu/tray pending attention', () => {
  it('raises attention while a request is pending and clears it afterwards', () => {
    const h = harness();

    const withOne = h.controller.apply(state([request('jrq_1', 'Nick')]));
    expect(withOne).toMatchObject({ pending: 1, badge: '1', shouldAlert: true });
    expect(withOne.label).toBe('Nick is waiting for you');
    expect(h.surface.setBadge).toHaveBeenLastCalledWith('1');
    expect(h.surface.alert).toHaveBeenCalledTimes(1);

    const cleared = h.controller.apply(state([]));
    expect(cleared).toMatchObject({ pending: 0, badge: '', label: 'Layup', shouldAlert: false });
    expect(h.surface.setBadge).toHaveBeenLastCalledWith('');
  });

  it('does not alert again while the same request stays pending', () => {
    const h = harness();
    const pending = state([request('jrq_1', 'Nick')]);

    h.controller.apply(pending);
    h.controller.apply(pending);
    h.controller.apply(pending);

    // Repeated clicks collapse upstream into one request, so the OS is
    // disturbed exactly once.
    expect(h.surface.alert).toHaveBeenCalledTimes(1);
    expect(h.controller.state().shouldAlert).toBe(false);
  });

  it('alerts again for a genuinely new request', () => {
    const h = harness();
    h.controller.apply(state([request('jrq_1', 'Nick')]));
    h.controller.apply(state([request('jrq_1', 'Nick'), request('jrq_2', 'Emelia')]));

    expect(h.surface.alert).toHaveBeenCalledTimes(2);
    expect(h.controller.state()).toMatchObject({ pending: 2, badge: '2' });
    expect(h.controller.state().label).toBe('2 people are waiting for you');
  });

  it('alerts again if a request is resolved and a new one arrives later', () => {
    const h = harness();
    h.controller.apply(state([request('jrq_1', 'Nick')]));
    h.controller.apply(state([])); // accepted, declined or expired
    h.controller.apply(state([request('jrq_2', 'Nick')]));

    expect(h.surface.alert).toHaveBeenCalledTimes(2);
  });

  it('ignores outgoing requests: your own waiting is not an interruption', () => {
    const h = harness();
    const result = h.controller.apply({ incoming: [], outgoing: [request('jrq_1', 'You')] });
    expect(result.pending).toBe(0);
    expect(h.surface.alert).not.toHaveBeenCalled();
  });
});
