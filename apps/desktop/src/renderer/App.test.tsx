import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('bootstrap shell', () => {
  it('renders the product identity and the protocol version', () => {
    Object.defineProperty(window, 'layup', {
      value: { protocolVersion: 1, app: { info: vi.fn() },
      capture: {
        sources: vi.fn(async () => ({ sources: [] })),
        permission: vi.fn(async () => ({
          status: 'granted',
          canCapture: true,
          guidance: '',
          canOpenSettings: false,
          platform: 'darwin',
        })),
        openSettings: vi.fn(),
      }, control: { status: vi.fn(async () => undefined) }, identity: { current: vi.fn(async () => undefined) }, people: { list: vi.fn(async () => ({ people: [] })), onChanged: vi.fn(() => () => {}) },
      requests: { list: vi.fn(async () => ({ incoming: [], outgoing: [] })), invite: vi.fn(), accept: vi.fn(), decline: vi.fn(), cancel: vi.fn(), onChanged: vi.fn(() => () => {}) },
      layup: { current: vi.fn(async () => ({ youAreCreatorMembership: false })), create: vi.fn(), join: vi.fn(), leave: vi.fn(), onChanged: vi.fn(() => () => {}) }, realtime: { status: vi.fn(async () => ({ status: 'idle', attempt: 0 })), onState: vi.fn(() => () => {}) } },
      configurable: true,
      writable: true,
    });
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Layup');
    expect(screen.getByText(/protocol v\d+/)).toBeTruthy();
    // People are the home surface, not a meeting wizard.
    expect(screen.getByRole('region', { name: 'People' })).toBeTruthy();
    expect(screen.queryByText(/new meeting/i)).toBeNull();
  });
});
