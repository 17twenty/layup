import type { AvState } from '../../core/av';
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
}: CompactBarProps) {
  return (
    <section className="call" aria-label="Layup" data-testid="compact-bar">
      {/* The whole area behind the faces drags the window; the controls opt
          out in CSS. */}
      <div className="call__stage drag">
        <FaceTiles
          variant="stage"
          local={local}
          remotes={remotes}
          {...(selfName ? { selfName } : {})}
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
      />
    </section>
  );
}
