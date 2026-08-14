import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteControlState } from '../../core/remote-control';
import { RemoteControlPanel } from './RemoteControlPanel';

const participants = [
  { membershipId: 'm-karl', displayName: 'Karl' },
  { membershipId: 'm-sam', displayName: 'Sam' },
];

const idle: RemoteControlState = {
  allowed: { pointer: false, keyboard: false },
  grants: [],
  anyoneHasControl: false,
};

function renderPanel(state: RemoteControlState = idle) {
  const handlers = {
    onSetAllowed: vi.fn(),
    onGrant: vi.fn(),
    onRevoke: vi.fn(),
    onRevokeAll: vi.fn(),
  };
  render(<RemoteControlPanel state={state} participants={participants} {...handlers} />);
  return handlers;
}

describe('remote control panel', () => {
  it('says plainly that nobody has control', async () => {
    renderPanel();
    expect(screen.getByTestId('control-indicator')).toHaveTextContent('Nobody can control this machine');
    // Nothing to stop, so no stop button to hunt through.
    expect(screen.queryByTestId('revoke-all')).toBeNull();
  });

  it('lets the presenter switch each scope on and off', async () => {
    const handlers = renderPanel();
    await userEvent.click(screen.getByTestId('allow-pointer'));
    expect(handlers.onSetAllowed).toHaveBeenCalledWith('pointer', true);

    await userEvent.click(screen.getByTestId('allow-keyboard'));
    expect(handlers.onSetAllowed).toHaveBeenCalledWith('keyboard', true);
  });

  it('will not offer control of a scope that is switched off', async () => {
    renderPanel();
    // The switch is the presenter's answer already; the button explains rather
    // than failing silently when pressed.
    expect(screen.getByTestId('grant-pointer-m-karl')).toBeDisabled();
    expect(screen.getByTestId('grant-pointer-m-karl')).toHaveAttribute(
      'title',
      'Mouse control is switched off',
    );
  });

  it('grants one participant at a time', async () => {
    const handlers = renderPanel({ ...idle, allowed: { pointer: true, keyboard: false } });
    await userEvent.click(screen.getByTestId('grant-pointer-m-karl'));
    expect(handlers.onGrant).toHaveBeenCalledWith('m-karl', 'pointer');
    // Sam is untouched.
    expect(handlers.onGrant).toHaveBeenCalledTimes(1);
  });

  it('shows who has control and stops them in one press', async () => {
    const handlers = renderPanel({
      allowed: { pointer: true, keyboard: true },
      grants: [{ membershipId: 'm-karl', scopes: ['keyboard', 'pointer'] }],
      anyoneHasControl: true,
    });

    // The indicator is unmistakable and names who it is (SPEC.md §13.3).
    expect(screen.getByTestId('control-indicator')).toHaveTextContent(
      'Karl can control this machine',
    );
    expect(screen.getByTestId('scopes-m-karl')).toHaveTextContent('keyboard + mouse');

    await userEvent.click(screen.getByTestId('revoke-m-karl'));
    expect(handlers.onRevoke).toHaveBeenCalledWith('m-karl');

    await userEvent.click(screen.getByTestId('revoke-all'));
    expect(handlers.onRevokeAll).toHaveBeenCalled();
  });

  it('names everybody who holds control', () => {
    renderPanel({
      allowed: { pointer: true, keyboard: true },
      grants: [
        { membershipId: 'm-karl', scopes: ['pointer'] },
        { membershipId: 'm-sam', scopes: ['keyboard'] },
      ],
      anyoneHasControl: true,
    });
    expect(screen.getByTestId('control-indicator')).toHaveTextContent(
      'Karl and Sam can control this machine',
    );
  });

  it('asks nothing about who created the layup', () => {
    // Presenter sovereignty: the panel has no concept of a creator or a
    // moderator, so it cannot accidentally require one (ADR-0005).
    const { container } = render(
      <RemoteControlPanel
        state={idle}
        participants={participants}
        onSetAllowed={vi.fn()}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
        onRevokeAll={vi.fn()}
      />,
    );
    expect(container.textContent?.toLowerCase()).not.toContain('creator');
    expect(container.textContent?.toLowerCase()).not.toContain('moderator');
    expect(container.textContent?.toLowerCase()).not.toContain('admin');
  });
});
