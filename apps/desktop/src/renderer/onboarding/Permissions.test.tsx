import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PermissionsResponse } from '../../shared/ipc';
import { Permissions } from './Permissions';

/**
 * The screen that exists because two people spent their first call fighting
 * System Settings instead of talking to each other.
 *
 * Every row has to answer three questions without being asked: what is this,
 * what does Layup want it for, and what do I press. The button is the part
 * that must never lie - "Allow" only where macOS will actually show a prompt.
 */
const granted = {
  status: 'granted' as const,
  ok: true,
  guidance: '',
  canOpenSettings: true,
  canRequest: false,
};

function state(overrides: Partial<PermissionsResponse> = {}): PermissionsResponse {
  return {
    camera: granted,
    microphone: granted,
    screen: granted,
    accessibility: granted,
    ...overrides,
  };
}

const all = vi.fn(async () => state());
const request = vi.fn(async () => true);
const openSettings = vi.fn(async () => true);

beforeEach(() => {
  vi.clearAllMocks();
  all.mockResolvedValue(state());
  Object.defineProperty(window, 'layup', {
    configurable: true,
    value: { permissions: { all, request, openSettings } },
  });
});

describe('asking for permissions before the call', () => {
  it('shows one row per permission, each saying what it is for', async () => {
    render(<Permissions />);

    for (const kind of ['camera', 'microphone', 'screen', 'accessibility'] as const) {
      expect(await screen.findByTestId(`permission-${kind}`)).toBeInTheDocument();
    }

    // Not four unexplained switches: each says what it buys in one line.
    expect(screen.getByTestId('permission-camera')).toHaveTextContent(/see your face/i);
    expect(screen.getByTestId('permission-microphone')).toHaveTextContent(/hear you/i);
    expect(screen.getByTestId('permission-screen')).toHaveTextContent(/share your screen/i);
    expect(screen.getByTestId('permission-accessibility')).toHaveTextContent(
      /mouse and keyboard/i,
    );
  });

  it('says where each one stands', async () => {
    all.mockResolvedValue(
      state({
        camera: { ...granted, status: 'not-determined', ok: false, canRequest: true, guidance: 'Layup has not asked yet.' },
        accessibility: { ...granted, status: 'denied', ok: false, guidance: 'macOS is not letting Layup control this Mac.' },
      }),
    );

    render(<Permissions />);

    expect(await screen.findByTestId('permission-status-microphone')).toHaveTextContent(/granted/i);
    expect(screen.getByTestId('permission-status-camera')).toHaveTextContent(/not asked/i);
    expect(screen.getByTestId('permission-status-accessibility')).toHaveTextContent(/blocked/i);
    // And the guidance is on screen, not hidden behind the status word.
    expect(screen.getByTestId('permission-accessibility')).toHaveTextContent(
      'macOS is not letting Layup control this Mac.',
    );
  });

  it('raises the real prompt for the camera, and re-reads the answer', async () => {
    all.mockResolvedValueOnce(
      state({ camera: { ...granted, status: 'not-determined', ok: false, canRequest: true, guidance: 'not asked yet' } }),
    );

    render(<Permissions />);

    await userEvent.click(await screen.findByTestId('permission-request-camera'));

    expect(request).toHaveBeenCalledWith('camera');
    // The prompt changes the answer, so the answer is asked for again rather
    // than assumed from what the button did.
    await waitFor(() => expect(all).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('permission-status-camera')).toHaveTextContent(/granted/i),
    );
  });

  it('never offers a prompt for the two macOS will not prompt for', async () => {
    all.mockResolvedValue(
      state({
        screen: { ...granted, status: 'denied', ok: false, guidance: 'open Screen Recording' },
        accessibility: { ...granted, status: 'denied', ok: false, guidance: 'open Accessibility' },
      }),
    );

    render(<Permissions />);

    await screen.findByTestId('permission-settings-screen');
    expect(screen.getByTestId('permission-settings-accessibility')).toBeInTheDocument();
    // A button labelled Allow that shows nothing is worse than no button.
    expect(screen.queryByTestId('permission-request-screen')).toBeNull();
    expect(screen.queryByTestId('permission-request-accessibility')).toBeNull();

    await userEvent.click(screen.getByTestId('permission-settings-accessibility'));
    expect(openSettings).toHaveBeenCalledWith('accessibility');
  });

  it('sends somebody to settings once macOS will not prompt again', async () => {
    all.mockResolvedValue(
      state({ camera: { ...granted, status: 'denied', ok: false, guidance: 'open Camera' } }),
    );

    render(<Permissions />);

    expect(await screen.findByTestId('permission-settings-camera')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-request-camera')).toBeNull();
  });

  it('says that screen recording needs a restart, because it does', async () => {
    render(<Permissions />);
    expect(await screen.findByTestId('permission-screen')).toHaveTextContent(/restart/i);
  });

  it('is skippable, because a permission screen must never be a wall', async () => {
    const onDone = vi.fn();
    render(<Permissions onDone={onDone} doneLabel="Skip for now" />);

    await userEvent.click(await screen.findByTestId('permissions-done'));
    expect(onDone).toHaveBeenCalled();
  });

  it('tells its caller what it found, so the way back stays marked', async () => {
    const onChanged = vi.fn();
    const missing = state({ screen: { ...granted, status: 'denied', ok: false, guidance: 'nope' } });
    all.mockResolvedValue(missing);

    render(<Permissions onChanged={onChanged} />);

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(missing));
  });

  it('says nothing needs doing off macOS rather than inventing chores', async () => {
    const notRequired = {
      status: 'not-required' as const,
      ok: true,
      guidance: '',
      canOpenSettings: false,
      canRequest: false,
    };
    all.mockResolvedValue({
      camera: notRequired,
      microphone: notRequired,
      screen: notRequired,
      accessibility: notRequired,
    });

    render(<Permissions />);

    expect(await screen.findByTestId('permission-status-camera')).toHaveTextContent(/not needed/i);
    expect(screen.queryByTestId('permission-request-camera')).toBeNull();
    expect(screen.queryByTestId('permission-settings-camera')).toBeNull();
  });

  it('keeps the window draggable, because it is a full-screen view', async () => {
    const { container } = render(<Permissions />);
    await screen.findByTestId('permission-camera');
    // The shell's title bar is rendered above this by App; the card itself must
    // not swallow the drag region it sits in.
    expect(container.querySelector('.onboarding')).toBeTruthy();
  });
});
