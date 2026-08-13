import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SharedScreen } from './SharedScreen';
import type { RemoteMedia } from '../../core/session';

const connected = { connection: 'connected', ice: 'connected', signalling: 'stable', connected: true } as const;

const remote = (overrides: Partial<RemoteMedia> = {}): RemoteMedia => ({
  membershipId: 'mem_remote',
  displayName: 'Karl',
  connection: { ...connected },
  ...overrides,
});

const stream = () => ({ getTracks: () => [] }) as unknown as MediaStream;

describe('shared screen', () => {
  it('renders the presenter’s screen and says who is sharing', () => {
    render(<SharedScreen remotes={[remote({ screen: stream() })]} />);

    const video = screen.getByTestId('shared-screen') as HTMLVideoElement;
    expect(video.srcObject).toBeTruthy();
    expect(video).toHaveAttribute('aria-label', "Karl's screen");
    expect(screen.getByText(/Karl is sharing/)).toBeTruthy();
  });

  it('treats no shared screen as a normal state, not an error', () => {
    render(<SharedScreen remotes={[remote()]} />);
    expect(screen.getByTestId('no-screen').textContent).toMatch(
      /Nobody is sharing a screen. Audio and video carry on regardless./,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so while you are the one sharing', () => {
    render(<SharedScreen remotes={[remote()]} localScreen={stream()} />);
    expect(screen.getByTestId('no-screen').textContent).toBe('You are sharing your screen.');
  });

  it('flags a reconnecting presenter rather than showing a frozen frame silently', () => {
    render(
      <SharedScreen
        remotes={[
          remote({
            screen: stream(),
            connection: { ...connected, connection: 'disconnected', connected: false },
          }),
        ]}
      />,
    );
    expect(screen.getByText(/reconnecting…/)).toBeTruthy();
  });
});
