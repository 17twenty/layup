import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureSourcesResponse } from '../../shared/ipc';

type CaptureSource = CaptureSourcesResponse['sources'][number];

/**
 * What happened when capture was asked for.
 *
 * A refusal is returned, not only stashed in state: the caller decides in the
 * same turn whether to announce a share, and React state is not readable yet
 * at that point. Announcing one anyway is how a refused `getUserMedia` became
 * a share with no video in it and no message anywhere.
 */
export type CaptureResult = { ok: true } | { ok: false; reason: string };

/**
 * Local screen capture: pick a source, preview it, stop cleanly.
 *
 * The renderer never receives a capture handle from the main process - it gets
 * a source *id* and asks Chromium for the stream itself, which is what keeps
 * capture inside the browser sandbox (ARCHITECTURE.md §8).
 */
export interface LocalCapture {
  sources: CaptureSource[];
  refresh(): Promise<void>;
  /** The source currently being captured, if any. */
  active?: CaptureSource;
  stream?: MediaStream;
  start(source: CaptureSource): Promise<CaptureResult>;
  stop(): void;
  error?: string;
}

/** Chromium's desktop-capture constraint shape. */
interface DesktopCaptureConstraints extends MediaTrackConstraints {
  mandatory: {
    chromeMediaSource: 'desktop';
    chromeMediaSourceId: string;
    maxFrameRate?: number;
  };
}

export function useLocalCapture(): LocalCapture {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [active, setActive] = useState<CaptureSource | undefined>();
  const [stream, setStream] = useState<MediaStream | undefined>();
  const [error, setError] = useState<string | undefined>();
  const streamRef = useRef<MediaStream | undefined>(undefined);

  const stop = useCallback(() => {
    // Every track must be stopped, or macOS keeps the screen-recording
    // indicator lit and Chromium keeps capturing.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    setStream(undefined);
    setActive(undefined);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await window.layup.capture.sources();
      setSources(next.sources);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const start = useCallback(
    async (source: CaptureSource): Promise<CaptureResult> => {
      stop();
      try {
        const video: DesktopCaptureConstraints = {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            maxFrameRate: 30,
          },
        };
        const next = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: video as MediaTrackConstraints,
        });
        streamRef.current = next;
        setStream(next);
        setActive(source);
        setError(undefined);
        return { ok: true };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        // Chromium's message for this is "Could not start video source", which
        // tells nobody anything. The cause is almost always the Screen
        // Recording permission, and the privileged side is the only place that
        // knows - so ask it, and say the thing somebody can act on.
        let reason = `Layup could not start capturing that screen (${detail}).`;
        try {
          const permission = await window.layup.capture.permission();
          if (!permission.canCapture && permission.guidance) reason = permission.guidance;
        } catch {
          // No answer: the raw refusal is still better than silence.
        }
        setError(reason);
        return { ok: false, reason };
      }
    },
    [stop],
  );

  // Leaving the screen behind must never leave capture running.
  useEffect(() => () => stop(), [stop]);

  return { sources, refresh, active, stream, start, stop, error };
}
