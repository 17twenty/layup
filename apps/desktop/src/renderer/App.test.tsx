import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('bootstrap shell', () => {
  it('renders the product identity and the protocol version', () => {
    Object.defineProperty(window, 'layup', {
      value: { protocolVersion: 1, app: { info: vi.fn() }, control: { status: vi.fn(async () => undefined) }, identity: { current: vi.fn(async () => undefined) }, realtime: { status: vi.fn(async () => ({ status: 'idle', attempt: 0 })), onState: vi.fn(() => () => {}) } },
      configurable: true,
      writable: true,
    });
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Layup');
    expect(screen.getByText(/protocol v\d+/)).toBeTruthy();
  });
});
