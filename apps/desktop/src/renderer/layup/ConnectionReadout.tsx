import type { IceRoute, RouteDiagnostics } from '../../core/ice-diagnostics';

/**
 * The connection readout: what a laggy call is actually doing.
 *
 * `session.diagnostics()` already knows the route, the candidate types and
 * the round-trip time - it just had no caller. Two people testing across
 * different networks cannot tell a relay from a bad link from a slow encoder
 * by feel, so this says it in words rather than making them guess.
 *
 * A chip is always on screen (never an empty box, even before the first
 * sample lands) and expands to the full panel on click - the same panel the
 * call surface's right-click menu opens, because "right click menu or
 * something" was the ask and the chip is what makes it findable at all.
 */

/** Plain words, not the raw ICE enum: nobody testing a call knows what
 * `srflx` means, and they should not have to. */
export function routeLabel(route: IceRoute | undefined): string {
  switch (route) {
    case 'direct':
      return 'Direct';
    case 'reflexive':
      return 'Direct (NAT)';
    case 'relay':
      return 'Relayed';
    default:
      return 'Unknown';
  }
}

function formatRtt(rttMs: number | undefined): string | undefined {
  if (rttMs === undefined) return undefined;
  return `${Math.round(rttMs)} ms`;
}

export interface ConnectionReadoutProps {
  /** This peer's diagnostics, or undefined before the first sample lands. */
  diagnostics?: RouteDiagnostics;
  /** The incoming video track carrying the call, for resolution and framerate. */
  videoTrack?: MediaStreamTrack;
  expanded: boolean;
  onToggle: () => void;
}

export function ConnectionReadout({ diagnostics, videoTrack, expanded, onToggle }: ConnectionReadoutProps) {
  const relayed = diagnostics?.relayed === true;
  const label = diagnostics ? routeLabel(diagnostics.route) : 'Connecting…';
  const rtt = formatRtt(diagnostics?.rttMs);

  const settings = videoTrack?.getSettings?.();
  const resolution = settings?.width && settings.height ? `${settings.width}×${settings.height}` : undefined;
  const framerate = settings?.frameRate ? `${Math.round(settings.frameRate)} fps` : undefined;

  return (
    <div className="connection-readout">
      <button
        type="button"
        className={relayed ? 'connection-chip connection-chip--relay' : 'connection-chip'}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label="Connection details"
        data-testid="connection-chip"
      >
        <span className="connection-chip__dot" aria-hidden="true" />
        <span className="connection-chip__label">{label}</span>
        {rtt ? <span className="connection-chip__rtt">{rtt}</span> : null}
      </button>

      {expanded ? (
        <section className="connection-panel" data-testid="connection-panel" aria-label="Connection details">
          <dl>
            <div className="connection-panel__row">
              <dt>Route</dt>
              <dd data-testid="connection-route">{label}</dd>
            </div>
            <div className="connection-panel__row">
              <dt>Round-trip time</dt>
              <dd data-testid="connection-rtt">{rtt ?? 'Connecting…'}</dd>
            </div>
            {diagnostics?.localCandidateType ? (
              <div className="connection-panel__row">
                <dt>Local candidate</dt>
                <dd>{diagnostics.localCandidateType}</dd>
              </div>
            ) : null}
            {diagnostics?.remoteCandidateType ? (
              <div className="connection-panel__row">
                <dt>Remote candidate</dt>
                <dd>{diagnostics.remoteCandidateType}</dd>
              </div>
            ) : null}
            {resolution ? (
              <div className="connection-panel__row">
                <dt>Resolution</dt>
                <dd data-testid="connection-resolution">{resolution}</dd>
              </div>
            ) : null}
            {framerate ? (
              <div className="connection-panel__row">
                <dt>Frame rate</dt>
                <dd data-testid="connection-framerate">{framerate}</dd>
              </div>
            ) : null}
          </dl>
          {relayed ? (
            <p className="connection-panel__relay-note" data-testid="connection-relay-note">
              Relayed through TURN - this explains extra latency, it is not a broken call.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
