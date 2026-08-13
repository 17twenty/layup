import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Invitations } from './Invitations';
import type { RequestsResponse } from '../../shared/ipc';

const incoming: RequestsResponse['incoming'][number] = {
  id: 'jrq_devaaaaab',
  type: 'INVITE_USER_TO_NEW_LAYUP',
  state: 'PENDING',
  fromUserId: 'usr_devnickx',
  fromName: 'Nick',
  toUserId: 'usr_devkarlx',
  toName: 'Karl',
  note: 'Auth is doing something dumb',
  createdAt: '2026-08-13T09:00:00Z',
  expiresAt: '2026-08-13T09:01:00Z',
};

function stub(initial: RequestsResponse) {
  let push: ((state: RequestsResponse) => void) | undefined;
  const api = {
    list: vi.fn(async () => initial),
    invite: vi.fn(),
    accept: vi.fn(async () => undefined),
    decline: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onChanged: vi.fn((handler: (state: RequestsResponse) => void) => {
      push = handler;
      return () => {
        push = undefined;
      };
    }),
  };
  Object.defineProperty(window, 'layup', {
    value: { protocolVersion: 1, requests: api },
    configurable: true,
    writable: true,
  });
  return { api, push: (state: RequestsResponse) => push?.(state) };
}

describe('invitations', () => {
  it('shows who wants you and why, with accept and decline', async () => {
    const bridge = stub({ incoming: [incoming], outgoing: [] });
    render(<Invitations />);

    await waitFor(() => expect(screen.getByText('Nick wants you in a layup')).toBeTruthy());
    expect(screen.getByText('“Auth is doing something dumb”')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(bridge.api.accept).toHaveBeenCalledWith('jrq_devaaaaab');

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(bridge.api.decline).toHaveBeenCalledWith('jrq_devaaaaab');
  });

  it('shows an outgoing request as waiting, with cancel', async () => {
    const bridge = stub({ incoming: [], outgoing: [incoming] });
    render(<Invitations />);

    await waitFor(() => expect(screen.getByText('Waiting for Karl…')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.api.cancel).toHaveBeenCalledWith('jrq_devaaaaab');
  });

  it('renders nothing when there is nothing pending', async () => {
    stub({ incoming: [], outgoing: [] });
    const view = render(<Invitations />);
    await waitFor(() => expect(view.container.firstChild).toBeNull());
  });

  it('disappears as soon as the request is resolved elsewhere', async () => {
    const bridge = stub({ incoming: [incoming], outgoing: [] });
    render(<Invitations />);
    await waitFor(() => expect(screen.getByTestId(`incoming-${incoming.id}`)).toBeTruthy());

    act(() => bridge.push({ incoming: [], outgoing: [] }));
    await waitFor(() => expect(screen.queryByTestId(`incoming-${incoming.id}`)).toBeNull());
  });

  it('names a knock as a knock and never invents a private title', async () => {
    stub({
      incoming: [{ ...incoming, type: 'KNOCK_TO_JOIN', note: undefined, layupTitle: undefined }],
      outgoing: [],
    });
    render(<Invitations />);
    await waitFor(() => expect(screen.getByText('Nick is knocking')).toBeTruthy());
  });

  it('surfaces a failed action', async () => {
    const bridge = stub({ incoming: [incoming], outgoing: [] });
    bridge.api.accept.mockRejectedValueOnce(new Error('POST failed with HTTP 409'));
    render(<Invitations />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(screen.getByText(/HTTP 409/)).toBeTruthy());
  });
});
