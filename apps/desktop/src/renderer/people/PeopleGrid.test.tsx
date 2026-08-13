import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PeopleGrid } from './PeopleGrid';
import type { PeopleResponse } from '../../shared/ipc';

type People = PeopleResponse['people'];

const people: People = [
  { userId: 'usr_devnickx', displayName: 'Nick', personal: 'AVAILABLE', activity: 'NONE' },
  {
    userId: 'usr_devkarlx',
    displayName: 'Karl',
    personal: 'AVAILABLE',
    activity: 'IN_PRIVATE_LAYUP',
    statusMessage: 'Auth is doing something dumb',
  },
  {
    userId: 'usr_devemeliax',
    displayName: 'Emelia',
    personal: 'AVAILABLE',
    activity: 'IN_OPEN_LAYUP',
    layupId: 'lay_abc12345',
    layupTitle: 'Capture path',
    participantCount: 3,
  },
  { userId: 'usr_devpriyax', displayName: 'Priya', personal: 'DND', activity: 'NONE' },
  { userId: 'usr_devsamx', displayName: 'Sam', personal: 'OFFLINE', activity: 'NONE' },
];

function stubBridge(initial: People) {
  let push: ((payload: PeopleResponse) => void) | undefined;
  Object.defineProperty(window, 'layup', {
    value: {
      protocolVersion: 1,
      app: { info: vi.fn() },
      control: { status: vi.fn() },
      identity: { current: vi.fn() },
      realtime: { status: vi.fn(), onState: vi.fn(() => () => {}) },
      people: {
        list: vi.fn(async () => ({ people: initial })),
        onChanged: vi.fn((handler: (payload: PeopleResponse) => void) => {
          push = handler;
          return () => {
            push = undefined;
          };
        }),
      },
    },
    configurable: true,
    writable: true,
  });
  return { push: (payload: PeopleResponse) => push?.(payload) };
}

describe('people home grid', () => {
  it('renders a tile per colleague with name, presence and activity', async () => {
    stubBridge(people);
    render(<PeopleGrid selfUserId="usr_devnickx" />);

    await waitFor(() => expect(screen.getByText('Karl')).toBeTruthy());

    // Self is not shown as someone to call.
    expect(screen.queryByText('Nick')).toBeNull();

    expect(screen.getByTestId('presence-usr_devkarlx').textContent).toBe('In a layup');
    expect(screen.getByTestId('presence-usr_devemeliax').textContent).toBe('In "Capture path"');
    expect(screen.getByTestId('presence-usr_devpriyax').textContent).toBe('Do not disturb');
    expect(screen.getByTestId('presence-usr_devsamx').textContent).toBe('Offline');
    expect(screen.getByText('“Auth is doing something dumb”')).toBeTruthy();
    expect(screen.getByText('3 in the layup')).toBeTruthy();
  });

  it('distinguishes states visually and by action', async () => {
    stubBridge(people);
    render(<PeopleGrid selfUserId="usr_devnickx" />);
    await waitFor(() => expect(screen.getByText('Karl')).toBeTruthy());

    const tile = (id: string) => screen.getByTestId(`person-${id}`);
    expect(tile('usr_devkarlx').className).toMatch(/tile--available/);
    expect(tile('usr_devkarlx').className).toMatch(/tile--activity-in_private_layup/);
    expect(tile('usr_devpriyax').className).toMatch(/tile--dnd/);
    expect(tile('usr_devsamx').className).toMatch(/tile--offline/);

    expect(screen.getByRole('button', { name: 'Knock' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Do not disturb' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Offline' })).toBeDisabled();
  });

  it('is a people list, not a meeting wizard', async () => {
    stubBridge(people);
    render(<PeopleGrid selfUserId="usr_devnickx" />);
    await waitFor(() => expect(screen.getByText('Karl')).toBeTruthy());

    expect(screen.queryByText(/new meeting/i)).toBeNull();
    expect(screen.getByRole('region', { name: 'People' })).toBeTruthy();
  });

  it('reports the chosen action for a person', async () => {
    stubBridge(people);
    const onAction = vi.fn();
    render(<PeopleGrid selfUserId="usr_devnickx" onAction={onAction} />);
    await waitFor(() => expect(screen.getByText('Karl')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: 'Knock' }));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_devkarlx' }),
      expect.objectContaining({ kind: 'knock' }),
    );
  });

  it('updates live when presence is pushed', async () => {
    const bridge = stubBridge(people);
    render(<PeopleGrid selfUserId="usr_devnickx" />);
    await waitFor(() => expect(screen.getByTestId('presence-usr_devsamx').textContent).toBe('Offline'));

    act(() => {
      bridge.push({
        people: people.map((person) =>
          person.userId === 'usr_devsamx' ? { ...person, personal: 'AVAILABLE' as const } : person,
        ),
      });
    });

    await waitFor(() => expect(screen.getByTestId('presence-usr_devsamx').textContent).toBe('Available'));
    expect(screen.getAllByRole('button', { name: 'Start layup' }).length).toBeGreaterThan(0);
  });
});
