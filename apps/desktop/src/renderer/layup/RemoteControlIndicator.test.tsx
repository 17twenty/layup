import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteControlState } from '../../core/remote-control';
import { RemoteControlIndicator } from './RemoteControlIndicator';

const held: RemoteControlState = {
  allowed: { pointer: true, keyboard: true },
  stopped: [],
  anyoneHasControl: true,
};

describe('remote control indicator', () => {
  it('shows nothing when nobody has control', () => {
    render(
      <RemoteControlIndicator
        state={{ allowed: { pointer: false, keyboard: false }, stopped: [], anyoneHasControl: false }}
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
        shortcut="Ctrl+Alt+Shift+\\"
        onStopAll={vi.fn()}
      />,
    );

    const banner = screen.getByTestId('remote-control-banner');
    expect(banner).toHaveTextContent('Everyone here can use your mouse and keyboard');
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
      <RemoteControlIndicator state={held} onStopAll={onStopAll} />,
    );
    await userEvent.click(screen.getByTestId('stop-all'));
    expect(onStopAll).toHaveBeenCalledTimes(1);
  });

  it('mentions anybody who has been stopped', () => {
    render(
      <RemoteControlIndicator
        state={{
          allowed: { pointer: true, keyboard: false },
          stopped: [{ membershipId: 'm-karl', scopes: ['pointer'] }],
          anyoneHasControl: true,
        }}
        onStopAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId('remote-control-banner')).toHaveTextContent(
      'Everyone here can use your mouse. 1 stopped.',
    );
  });

  it('still offers the button when the OS refused the shortcut', () => {
    render(<RemoteControlIndicator state={held} onStopAll={vi.fn()} />);
    expect(screen.queryByTestId('stop-shortcut')).toBeNull();
    expect(screen.getByTestId('stop-all')).toBeInTheDocument();
  });
});
