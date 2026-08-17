import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RemoteControlState } from '../../core/remote-control';
import { RemoteControlPanel } from './RemoteControlPanel';

const participants = [
  { membershipId: 'm-karl', displayName: 'Karl' },
  { membershipId: 'm-sam', displayName: 'Sam' },
];

const off: RemoteControlState = {
  allowed: { pointer: false, keyboard: false },
  stopped: [],
  anyoneHasControl: false,
};

function renderPanel(state: RemoteControlState = off) {
  const handlers = { onSetAllowed: vi.fn(), onStop: vi.fn(), onResume: vi.fn() };
  render(<RemoteControlPanel state={state} participants={participants} {...handlers} />);
  return handlers;
}

describe('sharing control of this machine', () => {
  it('offers two switches and nothing else', async () => {
    renderPanel();

    // Not a permissions matrix: no per-person, per-scope buttons to work
    // through before anybody can do anything.
    expect(screen.getByTestId('allow-pointer')).toBeInTheDocument();
    expect(screen.getByTestId('allow-keyboard')).toBeInTheDocument();
    expect(screen.queryByTestId('stop-m-karl')).toBeNull();
    expect(screen.getByTestId('control-summary')).toHaveTextContent('Only you can use this machine');
  });

  it('shares with the room in one click', async () => {
    const handlers = renderPanel();
    await userEvent.click(screen.getByTestId('allow-pointer'));
    expect(handlers.onSetAllowed).toHaveBeenCalledWith('pointer', true);
  });

  it('says plainly what is shared', () => {
    renderPanel({ ...off, allowed: { pointer: true, keyboard: true }, anyoneHasControl: true });
    expect(screen.getByTestId('control-summary')).toHaveTextContent(
      'Everyone here can use your mouse and keyboard',
    );
  });

  it('keeps stopping one person out of the way until it is needed', async () => {
    const handlers = renderPanel({
      ...off,
      allowed: { pointer: true, keyboard: false },
      anyoneHasControl: true,
    });

    // Present, but folded away: stopping somebody is the exception.
    await userEvent.click(screen.getByText('Stop one person'));
    await userEvent.click(screen.getByTestId('stop-m-karl'));
    expect(handlers.onStop).toHaveBeenCalledWith('m-karl');
  });

  it('shows who is stopped, and lets them back in', async () => {
    const handlers = renderPanel({
      allowed: { pointer: true, keyboard: false },
      stopped: [{ membershipId: 'm-karl', scopes: ['pointer'] }],
      anyoneHasControl: true,
    });

    expect(screen.getByText('Karl')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('resume-m-karl'));
    expect(handlers.onResume).toHaveBeenCalledWith('m-karl');
  });

  it('asks nothing about who created the layup', () => {
    const { container } = render(
      <RemoteControlPanel
        state={off}
        participants={participants}
        onSetAllowed={vi.fn()}
        onStop={vi.fn()}
        onResume={vi.fn()}
      />,
    );
    // Presenter sovereignty: a creator has no say over somebody else's
    // keyboard, so the panel has no concept of one (ADR-0005).
    const text = container.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('creator');
    expect(text).not.toContain('moderator');
    expect(text).not.toContain('admin');
  });
});
