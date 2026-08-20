import type { DeviceList } from '../../core/devices';
import { NO_DEVICES } from '../../core/devices';
import { ConnectionReadout, type ConnectionPeer } from '../layup/ConnectionReadout';
import { DevicePicker } from './DevicePicker';

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
 * The microphone and the camera each carry a caret, because "which
 * microphone?" is asked mid-call, by somebody who has just been told they
 * cannot be heard - and choosing there swaps the track in place rather than
 * renegotiating, so nobody's audio drops while they do it. The speaker lives
 * under the microphone's caret: it is the same question about the same
 * conversation.
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
  /**
   * Hands out a URL for this call and copies it. Absent means this surface
   * cannot invite anybody - there is no button rather than a dead one.
   */
  onInvite?: () => void;
  /** Takes that URL back. Shown only while there is a live one to take back. */
  onRevokeInvite?: () => void;
  /** True once a link has been handed out and not yet revoked. */
  hasInviteLink?: boolean;
  /** One entry per peer: who the link goes to, and what it is doing. */
  diagnosticsPeers?: readonly ConnectionPeer[];
  /** The incoming video track, for resolution and framerate. */
  diagnosticsVideoTrack?: MediaStreamTrack;
  diagnosticsExpanded: boolean;
  onToggleDiagnostics: () => void;
  /** What this machine has. Absent means no carets - nothing to choose from. */
  devices?: DeviceList;
  /** The devices in use; undefined means the system default. */
  microphoneId?: string;
  cameraId?: string;
  speakerId?: string;
  onSelectMicrophone?: (deviceId: string) => void;
  onSelectCamera?: (deviceId: string) => void;
  onSelectSpeaker?: (deviceId: string) => void;
  /** Opening a list is when the devices are worth re-reading. */
  onOpenDevices?: () => void;
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
  onInvite,
  onRevokeInvite,
  hasInviteLink = false,
  diagnosticsPeers,
  diagnosticsVideoTrack,
  diagnosticsExpanded,
  onToggleDiagnostics,
  devices = NO_DEVICES,
  microphoneId,
  cameraId,
  speakerId,
  onSelectMicrophone,
  onSelectCamera,
  onSelectSpeaker,
  onOpenDevices,
}: CallControlsProps) {
  return (
    <footer className="callbar no-drag" aria-label="Call controls">
      <ConnectionReadout
        {...(diagnosticsPeers ? { peers: diagnosticsPeers } : {})}
        {...(diagnosticsVideoTrack ? { videoTrack: diagnosticsVideoTrack } : {})}
        expanded={diagnosticsExpanded}
        onToggle={onToggleDiagnostics}
      />

      <div className="callbar__group">
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
        {onSelectMicrophone || onSelectSpeaker ? (
          <DevicePicker
            label="Choose microphone and speaker"
            testId="choose-microphone"
            labelsHidden={devices.labelsHidden}
            {...(onOpenDevices ? { onOpen: onOpenDevices } : {})}
            choices={[
              ...(onSelectMicrophone
                ? [
                    {
                      title: 'Microphone',
                      devices: devices.microphones,
                      ...(microphoneId ? { selectedId: microphoneId } : {}),
                      onSelect: onSelectMicrophone,
                    },
                  ]
                : []),
              ...(onSelectSpeaker
                ? [
                    {
                      title: 'Speaker',
                      devices: devices.speakers,
                      ...(speakerId ? { selectedId: speakerId } : {}),
                      onSelect: onSelectSpeaker,
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
      </div>

      <div className="callbar__group">
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
        {onSelectCamera ? (
          <DevicePicker
            label="Choose camera"
            testId="choose-camera"
            labelsHidden={devices.labelsHidden}
            {...(onOpenDevices ? { onOpen: onOpenDevices } : {})}
            choices={[
              {
                title: 'Camera',
                devices: devices.cameras,
                ...(cameraId ? { selectedId: cameraId } : {}),
                onSelect: onSelectCamera,
              },
            ]}
          />
        ) : null}
      </div>

      {/* Inviting somebody who has no Layup and no account. It sits next to
          Share because it is the same kind of act - opening this call to one
          more person - and because "I'll send you a link" is said mid-call,
          not from a settings screen. */}
      {onInvite ? (
        <div className="callbar__group">
          <button
            type="button"
            className="callbar__button"
            onClick={onInvite}
            data-testid="invite-by-link"
          >
            <LinkIcon />
            <span>{hasInviteLink ? 'Copy link' : 'Invite'}</span>
          </button>
          {hasInviteLink && onRevokeInvite ? (
            <button
              type="button"
              className="callbar__caret"
              onClick={onRevokeInvite}
              aria-label="Stop this invitation link working"
              data-testid="revoke-invite-link"
            >
              ✕
            </button>
          ) : null}
        </div>
      ) : null}

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

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M9.5 14.5 14.5 9.5M10 6.5l1.8-1.8a4 4 0 1 1 5.7 5.7L15.6 12M14 17.5l-1.8 1.8a4 4 0 1 1-5.7-5.7L8.4 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
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
