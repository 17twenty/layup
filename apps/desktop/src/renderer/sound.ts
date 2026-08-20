import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The knock: two short taps, generated with the Web Audio API rather than
 * shipped as a file - no asset, no licensing, no packaging step, and it
 * cannot go missing from the bundle (task 8 brief).
 */

/** The slice of AudioContext this needs, so it can be tested without one. */
export interface KnockAudioContext {
  readonly currentTime: number;
  createOscillator(): {
    type: OscillatorType;
    frequency: { value: number };
    connect(node: unknown): void;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): {
    gain: {
      value: number;
      setValueAtTime(value: number, time: number): void;
      exponentialRampToValueAtTime(value: number, time: number): void;
    };
    connect(node: unknown): void;
  };
  readonly destination: unknown;
  close?(): void;
}

export type KnockContextFactory = () => KnockAudioContext;

function defaultContext(): KnockAudioContext {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio is not available');
  return new Ctor() as unknown as KnockAudioContext;
}

/** Roughly 180ms apart, as asked for. */
export const KNOCK_GAP_SECONDS = 0.18;

const TAP_DURATION_SECONDS = 0.06;

function tap(ctx: KnockAudioContext, atSeconds: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = 220;
  oscillator.connect(gain);
  gain.connect(ctx.destination);

  const start = ctx.currentTime + atSeconds;
  const end = start + TAP_DURATION_SECONDS;
  // A knock, not a beep: a fast attack and decay rather than a held tone.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.4, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  oscillator.start(start);
  oscillator.stop(end + 0.02);
}

/** Plays the knock: two taps, ~180ms apart. Never throws. */
export function playKnock(createContext: KnockContextFactory = defaultContext): void {
  try {
    const ctx = createContext();
    tap(ctx, 0);
    tap(ctx, KNOCK_GAP_SECONDS);
    // Closing once the taps have finished stops contexts accumulating over a
    // long session that knocks occasionally.
    const lifetimeMs = (KNOCK_GAP_SECONDS + TAP_DURATION_SECONDS + 0.1) * 1000;
    setTimeout(() => {
      try {
        ctx.close?.();
      } catch {
        // Already closed, or closing is not supported - either is fine.
      }
    }, lifetimeMs);
  } catch {
    // No Web Audio, or the OS refused it (no output device, autoplay policy
    // before any user gesture, ...). A missed knock is not worth crashing the
    // renderer over - the badge and the bounce still happened.
  }
}

export interface AttentionSound {
  /** Whether the arrival knock is currently silenced. */
  muted: boolean;
  /** Toggles the mute preference, persisting it via the main process. */
  setMuted: (muted: boolean) => void;
}

/**
 * Plays the knock when a request arrives, unless muted.
 *
 * Subscribes to `window.layup.attention.onAlert`, which fires from the exact
 * same call as the dock bounce (main/index.ts's `alert()`) - so a knock plays
 * once per newly arrived request, never twice for the same one, and never
 * when the request count merely drops.
 */
export function useAttentionSound(createContext?: KnockContextFactory): AttentionSound {
  const [muted, setMutedState] = useState(false);
  // The subscription below is set up once; it needs the *current* mute
  // preference at the moment a knock arrives, not the one in effect when it
  // subscribed.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    let cancelled = false;
    void window.layup.preferences
      .get()
      .then((preferences) => {
        if (!cancelled) setMutedState(preferences.soundsMuted);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      window.layup.attention.onAlert(() => {
        if (!mutedRef.current) playKnock(createContext);
      }),
    [createContext],
  );

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    void window.layup.preferences.set({ soundsMuted: next }).catch(() => undefined);
  }, []);

  return { muted, setMuted };
}
