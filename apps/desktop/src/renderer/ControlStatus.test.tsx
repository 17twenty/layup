import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ControlStatus } from './ControlStatus';
import type { ControlStatusResponse } from '../shared/ipc';

function stubBridge(status: () => Promise<ControlStatusResponse>) {
  Object.defineProperty(window, 'layup', {
    value: { protocolVersion: 1, app: { info: vi.fn() }, control: { status }, identity: { current: vi.fn() }, realtime: { status: vi.fn(), onState: vi.fn(() => () => {}) } },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('control status view', () => {
  it('shows a connected server with its protocol version and latency', async () => {
    stubBridge(async () => ({
      status: 'connected',
      baseUrl: 'http://127.0.0.1:8787',
      clientProtocolVersion: 1,
      serverProtocolVersion: 1,
      environment: 'dev',
      latencyMs: 4.2,
      checkedAtMs: 1,
    }));

    render(<ControlStatus />);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(
        /connected · protocol v1 · dev · 4ms.*127\.0\.0\.1:8787/,
      );
    });
  });

  it('explains why the desktop is not connected', async () => {
    stubBridge(async () => ({
      status: 'unreachable',
      baseUrl: 'http://127.0.0.1:8787',
      clientProtocolVersion: 1,
      detail: 'control service unreachable (fetch failed: ECONNREFUSED)',
      checkedAtMs: 1,
    }));

    render(<ControlStatus />);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/unreachable — .*ECONNREFUSED/);
    });
  });

  it('reports a protocol mismatch distinctly', async () => {
    stubBridge(async () => ({
      status: 'incompatible',
      baseUrl: 'http://127.0.0.1:8787',
      clientProtocolVersion: 1,
      serverProtocolVersion: 99,
      detail: 'server speaks protocol v99, this desktop speaks v1',
      checkedAtMs: 1,
    }));

    render(<ControlStatus />);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/incompatible — server speaks protocol v99/);
    });
  });

  it('survives a failing bridge call', async () => {
    stubBridge(async () => {
      throw new Error('ipc exploded');
    });

    render(<ControlStatus />);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/status unavailable \(ipc exploded\)/);
    });
  });
});
