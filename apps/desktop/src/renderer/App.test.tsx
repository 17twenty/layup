import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('bootstrap shell', () => {
  it('renders the product identity and the protocol version', () => {
    Object.defineProperty(window, 'layup', {
      value: { protocolVersion: 1, app: { info: vi.fn() }, control: { status: vi.fn(async () => undefined) }, identity: { current: vi.fn(async () => undefined) }, people: { list: vi.fn(async () => ({ people: [] })), onChanged: vi.fn(() => () => {}) },
      realtime: { status: vi.fn(async () => ({ status: 'idle', attempt: 0 })), onState: vi.fn(() => () => {}) } },
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
