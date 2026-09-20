import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('restores the card and explains when accept itself fails', async () => {
    // Same shape as the existing decline-failure test, but for the button the
    // report was actually about. This passed even before the fix (the request
    // was still valid when it was restored) - it is here as a baseline next to
    // the case below, which did not.
    const bridge = stub({ incoming: [invitation], outgoing: [] });
    bridge.api.accept.mockRejectedValueOnce(new Error('POST failed with HTTP 409'));

    render(<Invitations />);
    await waitFor(() => expect(screen.getByTestId(`incoming-${invitation.id}`)).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(screen.getByText(/HTTP 409/)).toBeTruthy());
    expect(screen.getByTestId(`incoming-${invitation.id}`)).toBeTruthy();
  });

  it('surfaces the error even when the round trip outlives the invitation - the bug behind the report', async () => {
    // This reproduces "I could not hit join": the person clicks Join, the
    // card is optimistically hidden, and by the time the accept call comes
    // back (rejected - a conflict, a timeout, anything) the request's own
    // countdown has also run out. Before the fix, `visible` was empty for
    // every reason (hidden while resolving, then filtered as expired) and the
    // component's early return hid the error along with everything else: a
    // click that produced no card, no message, nothing.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const bridge = stub({
      incoming: [{ ...invitation, expiresAt: '2026-08-13T09:00:05.000Z' }], // 5s to live
      outgoing: [],
    });
    let reject: ((error: Error) => void) | undefined;
    bridge.api.accept.mockImplementationOnce(
      () =>
        new Promise((_resolve, rej) => {
          reject = rej;
        }),
    );

    render(<Invitations />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    // The round trip is slow enough that the invitation's own clock runs out
    // before the server answers.
    act(() => {
      vi.setSystemTime(NOW + 7_000);
      vi.advanceTimersByTime(7_000);
    });

    await act(async () => {
      reject?.(new Error('POST failed with HTTP 409'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/HTTP 409/)).toBeTruthy();
  });

  it('tells the user a request expired instead of letting the card vanish silently', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stub({ incoming: [{ ...invitation, expiresAt: '2026-08-13T09:00:05.000Z' }], outgoing: [] });

    render(<Invitations />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId(`incoming-${invitation.id}`)).toBeTruthy();

    act(() => {
      vi.setSystemTime(NOW + 6_000);
      vi.advanceTimersByTime(6_000);
    });

    expect(screen.queryByTestId(`incoming-${invitation.id}`)).toBeNull();
    expect(screen.getByText("Nick's invitation expired.")).toBeTruthy();
  });

  it('accepting still works when the invite arrived while already in another layup', async () => {
    const bridge = stub({ incoming: [invitation], outgoing: [] });
    render(<Invitations currentLayupId="lay_current01" />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Join theirs' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Join theirs' }));

    expect(bridge.api.accept).toHaveBeenCalledWith(invitation.id);
    expect(screen.queryByTestId(`incoming-${invitation.id}`)).toBeNull();
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
