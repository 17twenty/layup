import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Identity } from './Identity';
import type { IdentityResponse } from '../shared/ipc';

const forget = vi.fn(async () => ({ configured: false }));

function stub(identity: IdentityResponse) {
  forget.mockClear();
  Object.defineProperty(window, 'layup', {
    value: {
      server: { state: vi.fn(), add: vi.fn(), forget, onChanged: vi.fn(() => () => {}) },
      protocolVersion: 1,
      app: { info: vi.fn() },
      control: { status: vi.fn() },
      identity: { current: vi.fn(async () => identity) },
      people: { list: vi.fn(async () => ({ people: [] })), onChanged: vi.fn(() => () => {}) },
      requests: { list: vi.fn(async () => ({ incoming: [], outgoing: [] })), invite: vi.fn(), accept: vi.fn(), decline: vi.fn(), cancel: vi.fn(), onChanged: vi.fn(() => () => {}) },
      layup: { current: vi.fn(), create: vi.fn(), join: vi.fn(), leave: vi.fn(), onChanged: vi.fn(() => () => {}) },
      realtime: { status: vi.fn(), onState: vi.fn(() => () => {}) },
    },
    configurable: true,
    writable: true,
  });
}

describe('identity view', () => {
  it('names the development user and organisation', async () => {
    stub({
      devUser: 'karl',
      resolved: true,
      userId: 'usr_devkarlx',
      displayName: 'Karl',
      organisationId: 'org_devlayup',
      organisationName: 'Layup Development',
    });

    render(<Identity />);
    await waitFor(() => {
      expect(screen.getByRole('note').textContent).toMatch(
        /You are Karl · Layup Development · LAYUP_DEV_USER=karl/,
      );
    });
  });

  it('says why an identity is unresolved instead of pretending', async () => {
    stub({ devUser: 'karl', resolved: false, detail: 'control service unreachable' });

    render(<Identity />);
    await waitFor(() => {
      expect(screen.getByRole('note').textContent).toMatch(/unresolved — control service unreachable/);
    });
  });
});

/**
 * The way out (0.3.1, item 6).
 *
 * `server:forget` has existed since the config did, with nothing anywhere that
 * could call it. When the server stopped recognising a token the window said
 * "Identity unresolved — unrecognised token" and offered nothing at all, so the
 * only cure was deleting config.json from Application Support by hand. It is
 * needed *most* exactly when the identity cannot be resolved, which is the one
 * state where nothing else on the screen works either.
 */
describe('forgetting the server', () => {
  it('is offered while everything is fine, quietly', async () => {
    stub({
      devUser: 'karl',
      resolved: true,
      userId: 'usr_devkarlx',
      displayName: 'Karl',
      organisationId: 'org_devlayup',
      organisationName: 'Layup Development',
    });
    render(<Identity />);
    expect(await screen.findByTestId('forget-server')).toBeInTheDocument();
  });

  it('is offered, and explained, when the identity cannot be resolved', async () => {
    stub({ devUser: 'karl', resolved: false, detail: 'unrecognised token', credentialsRejected: true });
    render(<Identity />);

    const button = await screen.findByTestId('forget-server');
    expect(screen.getByRole('note').textContent).toMatch(/add the server again|sign(ed)? out|no longer recognises/i);
    await userEvent.click(button);
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('is offered while the server is merely unreachable, and says so differently', async () => {
    stub({ devUser: 'karl', resolved: false, detail: 'fetch failed' });
    render(<Identity />);

    // Not "you have been signed out": this is a server that cannot be reached,
    // and the config is still the right one.
    expect(await screen.findByTestId('forget-server')).toBeInTheDocument();
    expect(screen.getByRole('note').textContent).not.toMatch(/no longer recognises/i);
  });
});
