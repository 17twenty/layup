import { useEffect, useRef, useState } from 'react';
import { useLocalCapture } from './useLocalCapture';
import type { CapturePermissionResponse, CaptureSourcesResponse } from '../../shared/ipc';

type CaptureSource = CaptureSourcesResponse['sources'][number];

/**
 * Screen/window picker.
 *
 * Two callers, one component: on its own it previews locally, so capture can be
 * proved without a layup; given `onPicked` it hands the source straight to the
 * caller and shows no preview, because a second capture stream while you are
 * choosing one is a waste and lights the OS recording indicator for nothing.
 */
export interface CapturePickerProps {
  /** Given a source instead of previewing it. */
  onPicked?: (source: CaptureSource) => void;
}

export function CapturePicker({ onPicked }: CapturePickerProps = {}) {
  const capture = useLocalCapture();
  const screens = capture.sources.filter((source) => source.kind === 'screen').length;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [permission, setPermission] = useState<CapturePermissionResponse | undefined>();

  const refresh = capture.refresh;
  useEffect(() => {
    // Refreshing once on mount is enough: the picker is opened deliberately.
    void refresh();
    void window.layup.capture
      .permission()
      .then(setPermission)
      .catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = capture.stream ?? null;
  }, [capture.stream]);

  return (
    <section className="capture" aria-label="Screen sharing">
      <header className="people__header">
        <h2>Screen</h2>
        <button type="button" className="tile__action tile__action--secondary" onClick={() => void capture.refresh()}>
          Refresh sources
        </button>
      </header>

      {/* Displays and windows are granted separately on macOS, and the app
          usually has to be restarted before a new grant takes. Enumerating
          seven windows and no screens looks perfectly healthy while being
          useless, so say which half is missing. */}
      {permission?.canCapture && capture.sources.length > 0 && screens === 0 && (
        <p className="capture__permission" role="alert" data-testid="no-screens">
          Only windows are available - macOS has not granted this app whole-screen recording.
          {permission.canOpenSettings ? (
            <button
              type="button"
              className="tile__action tile__action--secondary"
              onClick={() => void window.layup.capture.openSettings()}
            >
              Open settings
            </button>
          ) : null}
        </p>
      )}

      {permission && !permission.canCapture && (
        <div className="capture__permission" role="alert" data-testid="capture-permission">
          <p>{permission.guidance}</p>
          {permission.canOpenSettings && (
            <button
              type="button"
              className="tile__action"
              onClick={() => void window.layup.capture.openSettings()}
            >
              Open screen recording settings
            </button>
          )}
        </div>
      )}

      {capture.error && <p className="layup__error">{capture.error}</p>}

      <ul className="capture__sources">
        {capture.sources.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              className={`capture__source${capture.active?.id === source.id ? ' capture__source--active' : ''}`}
              onClick={() => (onPicked ? onPicked(source) : void capture.start(source))}
              data-testid={`source-${source.id}`}
            >
              {source.thumbnailDataUrl && <img src={source.thumbnailDataUrl} alt="" />}
              <span>{source.name}</span>
              <span className="capture__kind">{source.kind}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* No preview when somebody else is going to use the source: a second
          capture stream costs nothing but the OS recording indicator. */}
      {!onPicked && capture.active && (
        <div className="capture__preview">
          <video ref={videoRef} autoPlay muted playsInline data-testid="capture-preview" />
          <button type="button" className="tile__action tile__action--secondary" onClick={capture.stop}>
            Stop preview
          </button>
        </div>
      )}
    </section>
  );
}
