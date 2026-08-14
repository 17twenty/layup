import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteControlState } from '../../core/remote-control';
import { RemoteControlIndicator } from './RemoteControlIndicator';

const participants = [
  { membershipId: 'm-karl', displayName: 'Karl' },
  { membershipId: 'm-sam', displayName: 'Sam' },
];

const held: RemoteControlState = {
  allowed: { pointer: true, keyboard: true },
  grants: [{ membershipId: 'm-karl', scopes: ['keyboard', 'pointer'] }],
  anyoneHasControl: true,
};

describe('remote control indicator', () => {
  it('shows nothing when nobody has control', () => {
    render(
      <RemoteControlIndicator
        state={{ allowed: { pointer: false, keyboard: false }, grants: [], anyoneHasControl: false }}
        participants={participants}
        onStopAll={vi.fn()}
      />,
    );
    // An indicator that is always on stops being an indicator.
    expect(screen.queryByTestId('remote-control-banner')).toBeNull();
  });

  it('is unmistakable while somebody holds control', () => {
    render(
      <RemoteControlIndicator
        state={held}
        participants={participants}
        shortcut="Ctrl+Alt+Shift+\\"
        onStopAll={vi.fn()}
      />,
    );

    const banner = screen.getByTestId('remote-control-banner');
    expect(banner).toHaveTextContent('Karl (keyboard + mouse) is controlling this machine');
    // A screen-reader user must not have to discover this for themselves.
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveAttribute('aria-live', 'assertive');

    // The shortcut is named where it is needed, not in a settings page nobody
    // opens while something alarming is happening.
    expect(screen.getByTestId('stop-shortcut')).toHaveTextContent('Ctrl+Alt+Shift+\\');
  });

  it('stops everything in one press', async () => {
    const onStopAll = vi.fn();
    render(
      <RemoteControlIndicator state={held} participants={participants} onStopAll={onStopAll} />,
    );
    await userEvent.click(screen.getByTestId('stop-all'));
    expect(onStopAll).toHaveBeenCalledTimes(1);
  });

  it('names everybody who is controlling', () => {
    render(
      <RemoteControlIndicator
        state={{
          allowed: { pointer: true, keyboard: true },
          grants: [
            { membershipId: 'm-karl', scopes: ['pointer'] },
            { membershipId: 'm-sam', scopes: ['keyboard'] },
          ],
          anyoneHasControl: true,
        }}
        participants={participants}
        onStopAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId('remote-control-banner')).toHaveTextContent(
      'Karl (mouse), Sam (keyboard) are controlling this machine',
    );
  });

  it('still offers the button when the OS refused the shortcut', () => {
    render(<RemoteControlIndicator state={held} participants={participants} onStopAll={vi.fn()} />);
    expect(screen.queryByTestId('stop-shortcut')).toBeNull();
    expect(screen.getByTestId('stop-all')).toBeInTheDocument();
  });
});
