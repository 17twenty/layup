import { useEffect, useRef, useState } from 'react';
import { useLocalCapture } from './useLocalCapture';
import type { CapturePermissionResponse } from '../../shared/ipc';

/**
 * Screen/window picker with a live local preview.
 *
 * Sharing with a layup arrives in P1-0308; this proves capture itself works and
 * that stopping releases the OS capture indicator.
 */
export function CapturePicker() {
  const capture = useLocalCapture();
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
              onClick={() => void capture.start(source)}
              data-testid={`source-${source.id}`}
            >
              {source.thumbnailDataUrl && <img src={source.thumbnailDataUrl} alt="" />}
              <span>{source.name}</span>
              <span className="capture__kind">{source.kind}</span>
            </button>
          </li>
        ))}
      </ul>

      {capture.active && (
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
