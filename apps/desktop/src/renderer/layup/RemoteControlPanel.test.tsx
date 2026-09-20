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

/**
 * The switch that appears to work (task 9).
 *
 * Without macOS Accessibility, `CGEventPost` silently discards every event -
 * the helper's own source calls this the worst possible failure. A switch that
 * flips on and changes nothing is that failure with a nicer face on it, so the
 * switch is not offered at all.
 */
const accessibilityMissing = {
  status: 'denied' as const,
  ok: false,
  guidance:
    'macOS is not letting Layup control this Mac, so remote control does nothing at all. ' +
    'Open Privacy & Security → Accessibility, tick Layup, then restart it.',
  canOpenSettings: true,
  canRequest: false,
};

describe('when macOS will not let anything be posted', () => {
  it('shows the guidance instead of a switch that does nothing', () => {
    const onOpenAccessibilitySettings = vi.fn();
    render(
      <RemoteControlPanel
        state={off}
        participants={participants}
        onSetAllowed={vi.fn()}
        onStop={vi.fn()}
        onResume={vi.fn()}
        accessibility={accessibilityMissing}
        onOpenAccessibilitySettings={onOpenAccessibilitySettings}
      />,
    );

    expect(screen.getByTestId('control-accessibility')).toHaveTextContent(
      /Privacy & Security.*Accessibility/,
    );
    // The switches are gone, not merely disabled-looking: a checkbox that
    // flips and changes nothing is exactly the silent failure.
    expect(screen.queryByTestId('allow-pointer')).toBeNull();
    expect(screen.queryByTestId('allow-keyboard')).toBeNull();
  });

  it('offers the settings pane, which is the only thing that fixes it', async () => {
    const onOpenAccessibilitySettings = vi.fn();
    render(
      <RemoteControlPanel
        state={off}
        participants={participants}
        onSetAllowed={vi.fn()}
        onStop={vi.fn()}
        onResume={vi.fn()}
        accessibility={accessibilityMissing}
        onOpenAccessibilitySettings={onOpenAccessibilitySettings}
      />,
    );

    await userEvent.click(screen.getByTestId('open-accessibility-settings'));
    expect(onOpenAccessibilitySettings).toHaveBeenCalled();
  });

  it('never claims the room can use a machine macOS is blocking', () => {
    render(
      <RemoteControlPanel
        state={{ allowed: { pointer: true, keyboard: true }, stopped: [], anyoneHasControl: true }}
        participants={participants}
        onSetAllowed={vi.fn()}
        onStop={vi.fn()}
        onResume={vi.fn()}
        accessibility={accessibilityMissing}
      />,
    );

    // A stale grant from before the permission was revoked must not become
    // "Everyone here can use your mouse and keyboard", which would be a lie.
    expect(screen.queryByTestId('control-summary')).toBeNull();
  });

  it('leaves the switches alone once macOS is happy', () => {
    render(
      <RemoteControlPanel
        state={off}
        participants={participants}
        onSetAllowed={vi.fn()}
        onStop={vi.fn()}
        onResume={vi.fn()}
        accessibility={{ ...accessibilityMissing, status: 'granted', ok: true, guidance: '' }}
      />,
    );

    expect(screen.getByTestId('allow-pointer')).toBeInTheDocument();
    expect(screen.queryByTestId('control-accessibility')).toBeNull();
  });

  it('does not block the switches on a platform with no such permission', () => {
    render(
      <RemoteControlPanel
        state={off}
        participants={participants}
        onSetAllowed={vi.fn()}
        onStop={vi.fn()}
        onResume={vi.fn()}
        accessibility={{
          status: 'not-required',
          ok: true,
          guidance: '',
          canOpenSettings: false,
          canRequest: false,
        }}
      />,
    );

    expect(screen.getByTestId('allow-pointer')).toBeInTheDocument();
  });
});
