import { useCallback, useState } from 'react';
import type { AvState } from '../../core/av';
import type { DeviceList } from '../../core/devices';
import type { RouteDiagnostics } from '../../core/ice-diagnostics';
import type { RemoteMedia } from '../../core/session';
import { FaceTiles } from '../layup/FaceTiles';
import { CallControls } from './CallControls';

/**
 * A call: the people, filling the window, and a bar of controls under them.
 *
 * This is what Layup looks like almost all the time - including while *you* are
 * sharing, because then you are looking at your own screen and the border
 * around it is the indicator. It grows only to choose a screen or to watch one.
 *
 * The faces are the content, not a strip of thumbnails beside something else.
 * At any size the window is given, they take all of it.
 *
 * This is also "the call surface" for connection diagnostics: a chip in the
 * bar underneath is always on screen (the discoverable entrance), and a
 * right-click anywhere here opens "Connection details" for the same panel -
 * because "right click menu or something" was what was actually asked for.
 */
export interface CompactBarProps {
  local: AvState;
  remotes: RemoteMedia[];
  selfName?: string;
  /** Set while this desktop is the one sharing. */
  presenting: boolean;
  onToggleCamera: (enabled: boolean) => void;
  onToggleMicrophone: (enabled: boolean) => void;
  onShare: () => void;
  onStopSharing: () => void;
  onLeave: () => void;
  /** This call's route, RTT and candidate types, or undefined before the first sample lands. */
  diagnostics?: RouteDiagnostics;
  /** The incoming video track, for resolution and framerate. */
  diagnosticsVideoTrack?: MediaStreamTrack;
  /** The microphones, cameras and speakers this machine has, for the carets. */
  devices?: DeviceList;
  /** Change a device mid-call. These swap the track in place; they never
   *  renegotiate, so the tiles below carry on without a flicker. */
  onSelectMicrophone?: (deviceId: string) => void;
  onSelectCamera?: (deviceId: string) => void;
  onSelectSpeaker?: (deviceId: string) => void;
  onOpenDevices?: () => void;
}

export function CompactBar({
  local,
  remotes,
  selfName,
  presenting,
  onToggleCamera,
  onToggleMicrophone,
  onShare,
  onStopSharing,
  onLeave,
  diagnostics,
  diagnosticsVideoTrack,
  devices,
  onSelectMicrophone,
  onSelectCamera,
  onSelectSpeaker,
  onOpenDevices,
}: CompactBarProps) {
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | undefined>();

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setMenuPosition({ x: event.clientX, y: event.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenuPosition(undefined), []);

  const openDetails = useCallback(() => {
    setDiagnosticsExpanded(true);
    setMenuPosition(undefined);
  }, []);

  return (
    <section className="call" aria-label="Layup" data-testid="compact-bar" onContextMenu={onContextMenu}>
      {/* The whole area behind the faces drags the window; the controls opt
          out in CSS. */}
      <div className="call__stage drag">
        <FaceTiles
          variant="stage"
          local={local}
          remotes={remotes}
          {...(selfName ? { selfName } : {})}
          {...(local.speakerId ? { speakerId: local.speakerId } : {})}
          onToggleCamera={onToggleCamera}
          onToggleMicrophone={onToggleMicrophone}
        />
      </div>

      <CallControls
        microphoneEnabled={local.microphoneEnabled}
        cameraEnabled={local.cameraEnabled}
        presenting={presenting}
        onToggleMicrophone={onToggleMicrophone}
        onToggleCamera={onToggleCamera}
        onShare={onShare}
        onStopSharing={onStopSharing}
        onLeave={onLeave}
        {...(diagnostics ? { diagnostics } : {})}
        {...(diagnosticsVideoTrack ? { diagnosticsVideoTrack } : {})}
        diagnosticsExpanded={diagnosticsExpanded}
        onToggleDiagnostics={() => setDiagnosticsExpanded((value) => !value)}
        {...(devices ? { devices } : {})}
        {...(local.microphoneId ? { microphoneId: local.microphoneId } : {})}
        {...(local.cameraId ? { cameraId: local.cameraId } : {})}
        {...(local.speakerId ? { speakerId: local.speakerId } : {})}
        {...(onSelectMicrophone ? { onSelectMicrophone } : {})}
        {...(onSelectCamera ? { onSelectCamera } : {})}
        {...(onSelectSpeaker ? { onSelectSpeaker } : {})}
        {...(onOpenDevices ? { onOpenDevices } : {})}
      />

      {/* The reporter asked for right-click. This is it: one item, over the
          call, that opens the same panel the chip does. */}
      {menuPosition ? (
        <div
          className="context-menu-scrim"
          data-testid="connection-menu-scrim"
          onClick={closeMenu}
          onContextMenu={(event) => {
            event.preventDefault();
            closeMenu();
          }}
        >
          <ul
            className="context-menu"
            role="menu"
            aria-label="Call surface"
            data-testid="connection-menu"
            style={{ left: menuPosition.x, top: menuPosition.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="context-menu__item"
                onClick={openDetails}
                data-testid="connection-details-menu-item"
              >
                Connection details
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </section>
  );
}
