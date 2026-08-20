import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateNotice } from './UpdateNotice';
import type { UpdateStateResponse } from '../shared/ipc';

function bridge(initial: UpdateStateResponse) {
  let push: ((state: UpdateStateResponse) => void) | undefined;
  const update = {
    state: vi.fn(async () => initial),
    install: vi.fn(async () => true),
    onChanged: vi.fn((handler: (state: UpdateStateResponse) => void) => {
      push = handler;
      return () => {
        push = undefined;
      };
    }),
  };
  Object.defineProperty(window, 'layup', {
    value: { update },
    configurable: true,
    writable: true,
  });
  return { update, emit: (state: UpdateStateResponse) => push?.(state) };
}

describe('the update affordance', () => {
  it('says nothing at all while there is nothing to do', async () => {
    bridge({ status: 'idle' });
    const { container } = render(<UpdateNotice />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('stays quiet while an update is merely available and downloading itself', async () => {
    const { emit } = bridge({ status: 'idle' });
    const { container } = render(<UpdateNotice />);
    emit({ status: 'available', version: '0.3.0' });
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('offers a restart, and only a restart, once one is ready', async () => {
    const { update } = bridge({ status: 'ready', version: '0.3.0' });
    render(<UpdateNotice />);

    const button = await screen.findByRole('button', { name: /restart layup/i });
    expect(button.textContent).toMatch(/Update ready \(v0\.3\.0\) — restart Layup/);
    // Not a dialog. Nothing to dismiss, nothing over anything.
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(button);
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  it('leaves the offer standing when the privileged side refuses mid-layup', async () => {
    const { update } = bridge({ status: 'ready', version: '0.3.0' });
    update.install.mockResolvedValueOnce(false);
    render(<UpdateNotice />);

    await userEvent.click(await screen.findByRole('button', { name: /restart layup/i }));

    // Refused is not gone: it is still there for after the call.
    expect(await screen.findByRole('button', { name: /restart layup/i })).toBeTruthy();
  });

  it('says a broken feed out loud, readably', async () => {
    bridge({ status: 'error', message: 'getaddrinfo ENOTFOUND layup.blah.au' });
    render(<UpdateNotice />);

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/Update check failed — getaddrinfo ENOTFOUND layup\.blah\.au/);
    expect(notice.textContent).not.toMatch(/undefined/);
  });

  it('never says undefined when an error arrives with no sentence', async () => {
    bridge({ status: 'error' });
    render(<UpdateNotice />);

    expect((await screen.findByRole('status')).textContent).not.toMatch(/undefined/);
  });

  it('survives a bridge that cannot answer', async () => {
    const { update } = bridge({ status: 'idle' });
    update.state.mockRejectedValueOnce(new Error('main is not listening'));

    const { container } = render(<UpdateNotice />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
