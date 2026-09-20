import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Join } from './Join';
import { GuestJoinError } from './guest-client';
import type { GuestJoinResult } from './guest-client';

const result: GuestJoinResult = {
  guestToken: 'gst_secret',
  membershipId: 'mem_guest',
  iceServers: [],
  layup: {
    id: 'lay_1',
    organisationId: 'org_1',
    title: 'Thursday sync',
    visibility: 'LINK',
    active: true,
    createdAt: '2026-08-17T09:00:00Z',
    hasCreatorAuthority: true,
    participants: [],
  },
};

describe('the guest join screen', () => {
  it('says the link is not valid when there is no token, and offers no form', () => {
    render(<Join serverUrl="https://layup.example" onJoined={vi.fn()} join={vi.fn()} />);

    expect(screen.getByRole('alert').textContent).toMatch(/this link is not valid/i);
    // Not an empty form somebody can fill in and be refused by: there is
    // nothing here that could ever work.
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
  });

  it('names the layup when it is known, and asks only for a name', () => {
    render(
      <Join
        serverUrl="https://layup.example"
        token="lnk_abc123"
        layupTitle="Thursday sync"
        onJoined={vi.fn()}
        join={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading').textContent).toMatch(/Thursday sync/);
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join/i })).toBeInTheDocument();
  });

  it('will not submit a blank name', async () => {
    const join = vi.fn(async () => result);
    render(<Join serverUrl="https://layup.example" token="lnk_abc123" onJoined={vi.fn()} join={join} />);

    expect(screen.getByRole('button', { name: /join/i })).toBeDisabled();
    // Whitespace is not a name either.
    await userEvent.type(screen.getByLabelText(/your name/i), '   ');
    expect(screen.getByRole('button', { name: /join/i })).toBeDisabled();
    expect(join).not.toHaveBeenCalled();
  });

  it('redeems the token from the fragment and hands the call over', async () => {
    const join = vi.fn(async () => result);
    const onJoined = vi.fn();
    render(<Join serverUrl="https://layup.example" token="lnk_abc123" onJoined={onJoined} join={join} />);

    await userEvent.type(screen.getByLabelText(/your name/i), 'Sam');
    await userEvent.click(screen.getByRole('button', { name: /join/i }));

    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(result));
    expect(join).toHaveBeenCalledWith({
      serverUrl: 'https://layup.example',
      token: 'lnk_abc123',
      displayName: 'Sam',
    });
  });

  it("shows the server's own words when the token is refused", async () => {
    const join = vi.fn(async () => {
      throw new GuestJoinError('this invitation link is not valid any more - ask for a new one', {
        status: 403,
        code: 'invalid_link',
      });
    });
    render(<Join serverUrl="https://layup.example" token="lnk_dead" onJoined={vi.fn()} join={join} />);

    await userEvent.type(screen.getByLabelText(/your name/i), 'Sam');
    await userEvent.click(screen.getByRole('button', { name: /join/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'this invitation link is not valid any more - ask for a new one',
      ),
    );
    // Still on the join screen, so a person can try a fresh link.
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
  });
});
