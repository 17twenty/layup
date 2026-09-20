import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KNOCK_GAP_SECONDS, playKnock, useAttentionSound, type KnockAudioContext } from './sound';

/** A fake AudioContext that records what would have been heard. */
function fakeContext() {
  const oscillators: Array<{ startedAt?: number; stoppedAt?: number }> = [];
  const gains: Array<{ ramps: Array<{ value: number; time: number }> }> = [];
  const ctx: KnockAudioContext = {
    currentTime: 5, // non-zero, so the test proves offsets are relative to it
    createOscillator: () => {
      const record: { startedAt?: number; stoppedAt?: number } = {};
      oscillators.push(record);
      return {
        type: 'sine',
        frequency: { value: 0 },
        connect: () => {},
        start: (when?: number) => {
          record.startedAt = when;
        },
        stop: (when?: number) => {
          record.stoppedAt = when;
        },
      };
    },
    createGain: () => {
      const record = { ramps: [] as Array<{ value: number; time: number }> };
      gains.push(record);
      return {
        gain: {
          value: 0,
          setValueAtTime: (value: number, time: number) => record.ramps.push({ value, time }),
          exponentialRampToValueAtTime: (value: number, time: number) =>
            record.ramps.push({ value, time }),
        },
        connect: () => {},
      };
    },
    destination: {},
    close: vi.fn(),
  };
  return { ctx, oscillators, gains };
}

describe('the knock', () => {
  it('is two taps, roughly 180ms apart', () => {
    const { ctx, oscillators } = fakeContext();

    playKnock(() => ctx);

    expect(oscillators).toHaveLength(2);
    const [first, second] = oscillators;
    if (!first || !second) throw new Error('expected two oscillators');
    expect(first.startedAt).toBeDefined();
    expect(second.startedAt).toBeDefined();
    expect(second.startedAt! - first.startedAt!).toBeCloseTo(KNOCK_GAP_SECONDS, 5);
  });

  it('shapes each tap with an attack and decay rather than a held tone', () => {
    const { ctx, gains } = fakeContext();

    playKnock(() => ctx);

    expect(gains).toHaveLength(2);
    for (const gain of gains) {
      expect(gain.ramps.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('never throws when Web Audio is unavailable', () => {
    expect(() =>
      playKnock(() => {
        throw new Error('no Web Audio here');
      }),
    ).not.toThrow();
  });
});

/** A minimal harness so the hook can be exercised through a real render. */
function Harness({ createContext }: { createContext?: () => KnockAudioContext }) {
  const sound = useAttentionSound(createContext);
  return (
    <div>
      <span data-testid="muted-state">{String(sound.muted)}</span>
      <button type="button" onClick={() => sound.setMuted(!sound.muted)}>
        toggle
      </button>
    </div>
  );
}

function bridge(options: { soundsMuted?: boolean } = {}) {
  const listeners = new Map<string, () => void>();
  const value = {
    preferences: {
      get: vi.fn(async () => ({ soundsMuted: options.soundsMuted ?? false })),
      set: vi.fn(async (next: { soundsMuted: boolean }) => next),
    },
    attention: {
      onAlert: vi.fn((handler: () => void) => {
        listeners.set('alert', handler);
        return () => listeners.delete('alert');
      }),
    },
  };
  Object.defineProperty(window, 'layup', { value, configurable: true, writable: true });
  return { value, fireAlert: () => listeners.get('alert')?.() };
}

describe('the attention sound', () => {
  it('plays once per newly arrived request, driven by the same event as the dock bounce', () => {
    const { fireAlert } = bridge();
    const { ctx } = fakeContext();
    const createContext = vi.fn(() => ctx);

    render(<Harness createContext={createContext} />);

    fireAlert();
    expect(createContext).toHaveBeenCalledTimes(1);

    // A second, distinct alert plays again - "once per newly arrived
    // request" is a property of main/attention.ts's `alerted` set, which the
    // renderer trusts rather than re-deriving.
    fireAlert();
    expect(createContext).toHaveBeenCalledTimes(2);
  });

  it('never plays when there is no fresh alert - e.g. the request count merely dropping', () => {
    bridge();
    const { ctx } = fakeContext();
    const createContext = vi.fn(() => ctx);

    render(<Harness createContext={createContext} />);

    expect(createContext).not.toHaveBeenCalled();
  });

  it('honours the persisted mute preference: loaded on mount, and no knock while muted', async () => {
    const { fireAlert } = bridge({ soundsMuted: true });
    const { ctx } = fakeContext();
    const createContext = vi.fn(() => ctx);

    render(<Harness createContext={createContext} />);

    await waitFor(() => expect(screen.getByTestId('muted-state').textContent).toBe('true'));

    fireAlert();
    expect(createContext).not.toHaveBeenCalled();
  });

  it('honours a mute flipped after mount, and persists the change', async () => {
    const { fireAlert, value } = bridge({ soundsMuted: false });
    const { ctx } = fakeContext();
    const createContext = vi.fn(() => ctx);
    const user = userEvent.setup();

    render(<Harness createContext={createContext} />);
    await waitFor(() => expect(screen.getByTestId('muted-state').textContent).toBe('false'));

    await user.click(screen.getByRole('button', { name: 'toggle' }));

    expect(screen.getByTestId('muted-state').textContent).toBe('true');
    expect(value.preferences.set).toHaveBeenCalledWith({ soundsMuted: true });

    fireAlert();
    expect(createContext).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('muted-state').textContent).toBe('false');

    fireAlert();
    expect(createContext).toHaveBeenCalledTimes(1);
  });
});
