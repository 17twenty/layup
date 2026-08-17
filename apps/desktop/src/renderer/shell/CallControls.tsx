import type { RouteDiagnostics } from '../../core/ice-diagnostics';
import { ConnectionReadout } from '../layup/ConnectionReadout';

/**
 * The bar along the bottom of a call.
 *
 * Four things, in the order they matter: your microphone, your camera, sharing
 * a screen, and leaving. Icon above label, because the labels are what make it
 * usable and the icons are what make it quick.
 *
 * Share is the accented one - it is why the application exists - and Leave is
 * the only red thing in the window.
 *
 * The connection chip rides along here too - it is the discoverable entrance
 * to the same readout the call surface's right-click menu opens (route,
 * candidate types, resolution, framerate). A laggy call is otherwise a mystery:
 * relayed, on a bad link, or the encoder, and nobody testing it can tell which.
 */
export interface CallControlsProps {
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  presenting: boolean;
  onToggleMicrophone: (enabled: boolean) => void;
  onToggleCamera: (enabled: boolean) => void;
  onShare: () => void;
  onStopSharing: () => void;
  onLeave: () => void;
  /** This call's route, RTT and candidate types, or undefined before the first sample lands. */
  diagnostics?: RouteDiagnostics;
  /** The incoming video track, for resolution and framerate. */
  diagnosticsVideoTrack?: MediaStreamTrack;
  diagnosticsExpanded: boolean;
  onToggleDiagnostics: () => void;
}

export function CallControls({
  microphoneEnabled,
  cameraEnabled,
  presenting,
  onToggleMicrophone,
  onToggleCamera,
  onShare,
  onStopSharing,
  onLeave,
  diagnostics,
  diagnosticsVideoTrack,
  diagnosticsExpanded,
  onToggleDiagnostics,
}: CallControlsProps) {
  return (
    <footer className="callbar no-drag" aria-label="Call controls">
      <ConnectionReadout
        {...(diagnostics ? { diagnostics } : {})}
        {...(diagnosticsVideoTrack ? { videoTrack: diagnosticsVideoTrack } : {})}
        expanded={diagnosticsExpanded}
        onToggle={onToggleDiagnostics}
      />

      <button
        type="button"
        className="callbar__button"
        aria-pressed={!microphoneEnabled}
        onClick={() => onToggleMicrophone(!microphoneEnabled)}
        data-testid="toggle-microphone"
      >
        <MicrophoneIcon muted={!microphoneEnabled} />
        <span>{microphoneEnabled ? 'Mute' : 'Unmute'}</span>
      </button>

      <button
        type="button"
        className="callbar__button"
        aria-pressed={!cameraEnabled}
        onClick={() => onToggleCamera(!cameraEnabled)}
        data-testid="toggle-camera"
      >
        <CameraIcon off={!cameraEnabled} />
        <span>{cameraEnabled ? 'Stop video' : 'Start video'}</span>
      </button>

      {presenting ? (
        <button
          type="button"
          className="callbar__button callbar__button--sharing"
          onClick={onStopSharing}
          data-testid="stop-sharing"
        >
          <ScreenIcon />
          <span>Stop sharing</span>
        </button>
      ) : (
        <button
          type="button"
          className="callbar__button callbar__button--share"
          onClick={onShare}
          data-testid="share-screen"
        >
          <ScreenIcon />
          <span>Share screen</span>
        </button>
      )}

      <button
        type="button"
        className="callbar__button callbar__button--leave"
        onClick={onLeave}
        data-testid="leave-layup"
      >
        <HangUpIcon />
        <span>Leave</span>
      </button>
    </footer>
  );
}

/* Inline, because four icons is not worth a dependency, and these never need
   to be themed or swapped. */

function MicrophoneIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z"
        fill="currentColor"
      />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {muted ? <path d="M4 3l16 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : null}
    </svg>
  );
}

function CameraIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="6" width="12" height="12" rx="2" fill="currentColor" />
      <path d="M16 11l5-3v8l-5-3z" fill="currentColor" />
      {off ? <path d="M4 3l16 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : null}
    </svg>
  );
}

function ScreenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="9" y="11" width="12" height="8" rx="2" fill="currentColor" />
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M2.5 13.5c5-4.7 14-4.7 19 0l-2.2 2.2a2 2 0 0 1-2.5.2l-1.7-1.2a2 2 0 0 1-.8-1.6v-1a12 12 0 0 0-4.6 0v1a2 2 0 0 1-.8 1.6l-1.7 1.2a2 2 0 0 1-2.5-.2Z"
        fill="currentColor"
      />
    </svg>
  );
}
