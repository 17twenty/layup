import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

/**
 * The bridge, with a server answer that can be held open.
 *
 * `server:state` is an IPC round trip, so the first paint happens before the
 * answer arrives. These tests pin down what is on screen in that gap: nothing
 * the answer might contradict, and no request to a server nobody has added.
 */
function bridge(serverState: Promise<unknown>) {
  const people = { list: vi.fn(async () => ({ people: [] })), onChanged: vi.fn(() => () => {}) };
  const layup = {
    current: vi.fn(async () => ({ youAreCreatorMembership: false })),
    create: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    open: vi.fn(async () => ({ layups: [] })),
    onChanged: vi.fn(() => () => {}),
  };
  const value = {
    protocolVersion: 1,
    app: { info: vi.fn() },
    server: {
      state: vi.fn(() => serverState),
      add: vi.fn(),
      forget: vi.fn(),
      onChanged: vi.fn(() => () => {}),
      onPrefill: vi.fn(() => () => {}),
    },
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
    },
    control: { status: vi.fn(async () => undefined) },
    identity: { current: vi.fn(async () => undefined) },
    people,
    requests: {
      list: vi.fn(async () => ({ incoming: [], outgoing: [] })),
      invite: vi.fn(),
      accept: vi.fn(),
      decline: vi.fn(),
      cancel: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    layup,
    ui: { setMode: vi.fn(async () => ({ mode: 'home' })), onMode: vi.fn(() => () => {}) },
    realtime: {
      status: vi.fn(async () => ({ status: 'idle', attempt: 0 })),
      onState: vi.fn(() => () => {}),
    },
  };
  Object.defineProperty(window, 'layup', { value, configurable: true, writable: true });
  return value;
}

describe('bootstrap shell', () => {
  it('renders the product identity and the protocol version', async () => {
    bridge(Promise.resolve({ configured: true, serverUrl: 'https://layup.example', displayName: 'Nick' }));

    render(<App />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Layup');
    expect(screen.getByText(/protocol v\d+/)).toBeTruthy();
    // People are the home surface, not a meeting wizard.
    expect(screen.getByRole('region', { name: 'People' })).toBeTruthy();
    expect(screen.queryByText(/new meeting/i)).toBeNull();
  });

  it('shows nothing but the add-server screen when no server has been added', async () => {
    bridge(Promise.resolve({ configured: false }));

    render(<App />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Add a server');
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
    expect(screen.queryByText(/protocol v\d+/)).toBeNull();
    expect(screen.queryByText('People → Layup → Share → Collaborate')).toBeNull();
  });

  it('waits for the answer rather than painting a screen it may have to take back', async () => {
    // The answer never comes: this is the first frame, held open.
    const api = bridge(new Promise(() => {}));

    render(<App />);

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
    // And nothing has been asked of a server nobody has added yet.
    expect(api.people.list).not.toHaveBeenCalled();
    expect(api.layup.current).not.toHaveBeenCalled();
    expect(api.identity.current).not.toHaveBeenCalled();
    expect(api.control.status).not.toHaveBeenCalled();
    expect(api.realtime.status).not.toHaveBeenCalled();
    expect(api.requests.list).not.toHaveBeenCalled();
  });
});
