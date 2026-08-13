import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RealtimeStatus } from './RealtimeStatus';
import type { RealtimeStateResponse } from '../shared/ipc';

function stub() {
  let push: ((state: RealtimeStateResponse) => void) | undefined;
  const unsubscribe = vi.fn();
  Object.defineProperty(window, 'layup', {
    value: {
      protocolVersion: 1,
      app: { info: vi.fn() },
      control: { status: vi.fn() },
      identity: { current: vi.fn() },
      people: { list: vi.fn(async () => ({ people: [] })), onChanged: vi.fn(() => () => {}) },
      layup: { current: vi.fn(), create: vi.fn(), join: vi.fn(), leave: vi.fn(), onChanged: vi.fn(() => () => {}) },
      realtime: {
        status: vi.fn(async () => ({ status: 'connecting', attempt: 0 }) as RealtimeStateResponse),
        onState: vi.fn((handler: (state: RealtimeStateResponse) => void) => {
          push = handler;
          return unsubscribe;
        }),
      },
    },
    configurable: true,
    writable: true,
  });
  return { push: (state: RealtimeStateResponse) => push?.(state), unsubscribe };
}

describe('realtime status view', () => {
  it('renders pushed state and unsubscribes on unmount', async () => {
    const bridge = stub();
    const view = render(<RealtimeStatus />);

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/connecting/));

    bridge.push({ status: 'connected', attempt: 0, connectionId: 'conn-9' });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Realtime: connected \(connection conn-9\)/);
    });

    bridge.push({ status: 'reconnecting', attempt: 2, lastError: 'heartbeat timeout' });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/reconnecting \(attempt 2 — heartbeat timeout\)/);
    });

    view.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
