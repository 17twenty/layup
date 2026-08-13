import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Invitations } from './Invitations';
import type { RequestsResponse } from '../../shared/ipc';

const NOW = Date.parse('2026-08-13T09:00:00.000Z');

const invitation: RequestsResponse['incoming'][number] = {
  id: 'jrq_devaaaaab',
  type: 'INVITE_USER_TO_NEW_LAYUP',
  state: 'PENDING',
  fromUserId: 'usr_devnickx',
  fromName: 'Nick',
  toUserId: 'usr_devkarlx',
  toName: 'Karl',
  note: 'Auth is doing something dumb',
  createdAt: '2026-08-13T09:00:00.000Z',
  expiresAt: '2026-08-13T09:01:00.000Z',
};

function stub(initial: RequestsResponse) {
  let push: ((state: RequestsResponse) => void) | undefined;
  const api = {
    list: vi.fn(async () => initial),
    invite: vi.fn(),
    knock: vi.fn(),
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

beforeEach(() => {
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('incoming invitation experience', () => {
  it('is obvious and complete without taking over the app', async () => {
    stub({ incoming: [invitation], outgoing: [] });
    const view = render(<Invitations />);

    await waitFor(() => expect(screen.getByText('Nick wants you in a layup')).toBeTruthy());
    expect(screen.getByText('“Auth is doing something dumb”')).toBeTruthy();
    expect(screen.getByTestId(`expiry-${invitation.id}`).textContent).toBe('60s left');

    // It is a section in the page, not a modal that blocks everything else.
    expect(screen.getByRole('region', { name: 'Invitations' })).toBeTruthy();
    expect(view.container.querySelector('dialog')).toBeNull();
  });

  it('accepting removes the card immediately', async () => {
    const bridge = stub({ incoming: [invitation], outgoing: [] });
    let release: (() => void) | undefined;
    bridge.api.accept.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );

    render(<Invitations />);
    await waitFor(() => expect(screen.getByTestId(`incoming-${invitation.id}`)).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    // Gone before the round trip finishes.
    expect(screen.queryByTestId(`incoming-${invitation.id}`)).toBeNull();
    act(() => release?.());
  });

  it('restores the card and explains when a command fails', async () => {
    const bridge = stub({ incoming: [invitation], outgoing: [] });
    bridge.api.decline.mockRejectedValueOnce(new Error('POST failed with HTTP 409'));

    render(<Invitations />);
    await waitFor(() => expect(screen.getByTestId(`incoming-${invitation.id}`)).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.getByText(/HTTP 409/)).toBeTruthy());
    expect(screen.getByTestId(`incoming-${invitation.id}`)).toBeTruthy();
  });

  it('filters context by request type: a knock never names the layup', async () => {
    stub({
      incoming: [
        { ...invitation, type: 'KNOCK_TO_JOIN', note: undefined, layupId: undefined, layupTitle: undefined },
      ],
      outgoing: [],
    });
    render(<Invitations />);

    await waitFor(() => expect(screen.getByText('Nick is knocking')).toBeTruthy());
    expect(screen.getByText('They want to join the layup you are in')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Let them in' })).toBeTruthy();
  });

  it('shows a layup title only when the server sent one', async () => {
    stub({
      incoming: [{ ...invitation, type: 'INVITE_USER_TO_LAYUP', layupTitle: 'Capture path' }],
      outgoing: [],
    });
    render(<Invitations />);
    await waitFor(() => expect(screen.getByText('“Capture path”')).toBeTruthy());
  });

  it('counts down and drops a request that runs out', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stub({ incoming: [invitation], outgoing: [] });
    render(<Invitations />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId(`expiry-${invitation.id}`).textContent).toBe('60s left');

    act(() => {
      vi.setSystemTime(NOW + 30_000);
      vi.advanceTimersByTime(1000);
    });
    // The tick that fires at +31s is what re-renders, so 29 seconds remain.
    expect(screen.getByTestId(`expiry-${invitation.id}`).textContent).toBe('29s left');

    act(() => {
      vi.setSystemTime(NOW + 61_000);
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId(`incoming-${invitation.id}`)).toBeNull();
  });

  it('disappears as soon as the request is resolved elsewhere', async () => {
    const bridge = stub({ incoming: [invitation], outgoing: [] });
    render(<Invitations />);
    await waitFor(() => expect(screen.getByTestId(`incoming-${invitation.id}`)).toBeTruthy());

    act(() => bridge.push({ incoming: [], outgoing: [] }));
    await waitFor(() => expect(screen.queryByTestId(`incoming-${invitation.id}`)).toBeNull());
  });

  it('shows an outgoing knock as knocking, with cancel', async () => {
    const bridge = stub({ incoming: [], outgoing: [{ ...invitation, type: 'KNOCK_TO_JOIN' }] });
    render(<Invitations />);

    await waitFor(() => expect(screen.getByText('Knocking…')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.api.cancel).toHaveBeenCalledWith(invitation.id);
  });
});

describe('being invited while already in a layup', () => {
  it('offers Join theirs / Invite them here / Decline', async () => {
    const bridge = stub({ incoming: [invitation], outgoing: [] });
    render(<Invitations currentLayupId="lay_current01" />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Join theirs' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Invite them here' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Invite them here' }));
    expect(bridge.api.invite).toHaveBeenCalledWith('usr_devnickx', { layupId: 'lay_current01' });
    await waitFor(() => expect(bridge.api.decline).toHaveBeenCalledWith(invitation.id));
  });

  it('keeps the plain two-button choice when you are in nothing', async () => {
    stub({ incoming: [invitation], outgoing: [] });
    render(<Invitations />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Invite them here' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
  });

  it('never offers to move you for a knock', async () => {
    stub({ incoming: [{ ...invitation, type: 'KNOCK_TO_JOIN' }], outgoing: [] });
    render(<Invitations currentLayupId="lay_current01" />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Let them in' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Invite them here' })).toBeNull();
  });
});
