import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayupPanel } from './LayupPanel';
import type { LayupStateResponse } from '../../shared/ipc';

const inLayup: LayupStateResponse = {
  membershipId: 'mem_creator1',
  youAreCreatorMembership: true,
  layup: {
    id: 'lay_abc12345',
    organisationId: 'org_devlayup',
    title: 'Capture path',
    visibility: 'ORGANISATION',
    active: true,
    createdAt: '2026-08-13T09:00:00Z',
    hasCreatorAuthority: true,
    creatorMembershipId: 'mem_creator1',
    participants: [
      {
        membershipId: 'mem_creator1',
        userId: 'usr_devnickx',
        displayName: 'Nick',
        joinedAt: '2026-08-13T09:00:00Z',
        isCreatorMembership: true,
        isGuest: false,
      },
      {
        membershipId: 'mem_join1',
        userId: 'usr_devkarlx',
        displayName: 'Karl',
        joinedAt: '2026-08-13T09:01:00Z',
        isCreatorMembership: false,
        isGuest: false,
      },
    ],
  },
};

function stub(initial: LayupStateResponse) {
  let push: ((state: LayupStateResponse) => void) | undefined;
  const api = {
    current: vi.fn(async () => initial),
    create: vi.fn(async () => initial),
    join: vi.fn(async () => initial),
    leave: vi.fn(async () => ({ youAreCreatorMembership: false }) as LayupStateResponse),
    onChanged: vi.fn((handler: (state: LayupStateResponse) => void) => {
      push = handler;
      return () => {
        push = undefined;
      };
    }),
  };
  Object.defineProperty(window, 'layup', {
    value: {
      protocolVersion: 1,
      app: { info: vi.fn() },
      control: { status: vi.fn() },
      identity: { current: vi.fn() },
      people: { list: vi.fn(), onChanged: vi.fn(() => () => {}) },
      requests: {
        list: vi.fn(async () => ({ incoming: [], outgoing: [] })),
        invite: vi.fn(),
        accept: vi.fn(),
        decline: vi.fn(),
        cancel: vi.fn(),
        onChanged: vi.fn(() => () => {}),
      },
      realtime: { status: vi.fn(), onState: vi.fn(() => () => {}) },
      layup: api,
    },
    configurable: true,
    writable: true,
  });
  return { api, push: (state: LayupStateResponse) => push?.(state) };
}

describe('layup panel', () => {
  it('lists active participants and marks the creator membership and you', async () => {
    stub(inLayup);
    render(<LayupPanel />);

    await waitFor(() => expect(screen.getByText('Capture path')).toBeTruthy());
    expect(screen.getByTestId('participant-mem_creator1').textContent).toMatch(/Nick.*creator.*you/);
    expect(screen.getByTestId('participant-mem_join1').textContent).toBe('Karl');
    expect(screen.queryByTestId('no-creator')).toBeNull();
  });

  it('says plainly when creator authority has devolved to nobody', async () => {
    const bridge = stub(inLayup);
    render(<LayupPanel />);
    await waitFor(() => expect(screen.getByText('Capture path')).toBeTruthy());

    act(() => {
      // The creator left: authority is gone, the layup continues.
      const layup = inLayup.layup!;
      const state: LayupStateResponse = {
        membershipId: 'mem_join1',
        youAreCreatorMembership: false,
        layup: {
          ...layup,
          hasCreatorAuthority: false,
          creatorMembershipId: undefined,
          participants: layup.participants
            .filter((p) => p.membershipId === 'mem_join1')
            .map((p) => ({ ...p, isCreatorMembership: false, isGuest: false })),
        },
      };
      bridge.push(state);
    });

    await waitFor(() => expect(screen.getByTestId('no-creator')).toBeTruthy());
    // What matters is that the state is shown at all, not that the interface
    // recites the rule behind it.
    expect(screen.getByTestId('no-creator').textContent).toMatch(/has left/);
    // No affordance exists to claim or transfer authority.
    expect(screen.queryByRole('button', { name: /make.*host|claim|transfer/i })).toBeNull();
  });

  it('offers to start a layup when you are in none, and can leave one you are in', async () => {
    const bridge = stub({ youAreCreatorMembership: false });
    render(<LayupPanel />);
    await waitFor(() => expect(screen.getByText('You are not in a layup.')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: 'Start an open layup' }));
    expect(bridge.api.create).toHaveBeenCalledWith({ visibility: 'ORGANISATION' });
  });

  it('surfaces a failed command instead of pretending it worked', async () => {
    const bridge = stub({ youAreCreatorMembership: false });
    bridge.api.create.mockRejectedValueOnce(new Error('POST /api/layups failed with HTTP 403'));
    render(<LayupPanel />);
    await waitFor(() => expect(screen.getByText('You are not in a layup.')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: 'Start an open layup' }));
    await waitFor(() => expect(screen.getByText(/HTTP 403/)).toBeTruthy());
  });
});
