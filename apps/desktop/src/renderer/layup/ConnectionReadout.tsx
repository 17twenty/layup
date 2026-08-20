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
 *
 * **One row per peer, named.** `session.diagnostics()` has always returned one
 * `RouteDiagnostics` per peer and this took a single one, with nothing saying
 * whose: with a guest in the call it was whichever peer came out of the record
 * first, so the panel could report a healthy direct link while somebody else
 * was on a broken one. "Whose link is bad" is the only question it exists to
 * answer, and answering it needs the name beside the numbers.
 *
 * The chip has one line for however many links there are, so it shows the
 * *worst* of them and says how many it is standing in for. A summary that
 * picks a good link out of a bad call is worse than no summary.
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

export interface ConnectionPeer {
  membershipId: string;
  /** Who this link goes to, as the roster names them. */
  label: string;
  /** Their diagnostics, or undefined before the first sample for them lands. */
  diagnostics?: RouteDiagnostics;
}

export interface ConnectionReadoutProps {
  /** One entry per peer. Empty before there is anybody to describe. */
  peers?: readonly ConnectionPeer[];
  /** The incoming video track carrying the call, for resolution and framerate. */
  videoTrack?: MediaStreamTrack;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * How bad a link is, for choosing what the one-line chip says.
 *
 * No sample at all ranks worst: "we cannot see this link" must never be
 * summarised as somebody else's healthy one.
 */
function badness(peer: ConnectionPeer): number {
  if (!peer.diagnostics) return 4;
  if (peer.diagnostics.relayed || peer.diagnostics.route === 'relay') return 3;
  if (peer.diagnostics.route === undefined || peer.diagnostics.route === 'unknown') return 2;
  if (peer.diagnostics.route === 'reflexive') return 1;
  return 0;
}

function worstOf(peers: readonly ConnectionPeer[]): ConnectionPeer | undefined {
  return [...peers].sort(
    (a, b) => badness(b) - badness(a) || (b.diagnostics?.rttMs ?? 0) - (a.diagnostics?.rttMs ?? 0),
  )[0];
}

export function ConnectionReadout({ peers = [], videoTrack, expanded, onToggle }: ConnectionReadoutProps) {
  const worst = worstOf(peers);
  const relayed = peers.some((peer) => peer.diagnostics?.relayed === true);
  const summary = worst?.diagnostics ? routeLabel(worst.diagnostics.route) : 'Connecting…';
  const summaryRtt = formatRtt(worst?.diagnostics?.rttMs);

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
        <span className="connection-chip__label">{summary}</span>
        {summaryRtt ? <span className="connection-chip__rtt">{summaryRtt}</span> : null}
        {peers.length > 1 ? (
          <span className="connection-chip__count">{peers.length} links</span>
        ) : null}
      </button>

      {expanded ? (
        <section className="connection-panel" data-testid="connection-panel" aria-label="Connection details">
          {peers.length === 0 ? (
            <p className="connection-panel__empty">Connecting…</p>
          ) : (
            peers.map((peer) => (
              <PeerRows key={peer.membershipId} peer={peer} />
            ))
          )}

          {/* The local track, so these describe what is on screen rather than
              any one link. Said once, under the links they apply to. */}
          {resolution || framerate ? (
            <dl className="connection-panel__video">
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
          ) : null}

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

/** One person's link, with their name on it. */
function PeerRows({ peer }: { peer: ConnectionPeer }) {
  const label = peer.diagnostics ? routeLabel(peer.diagnostics.route) : 'Connecting…';
  const rtt = formatRtt(peer.diagnostics?.rttMs);

  return (
    <section
      className="connection-panel__peer"
      data-testid={`connection-peer-${peer.membershipId}`}
      aria-label={`Connection to ${peer.label}`}
    >
      <h3 className="connection-panel__who">{peer.label}</h3>
      <dl>
        <div className="connection-panel__row">
          <dt>Route</dt>
          <dd data-testid={`connection-route-${peer.membershipId}`}>{label}</dd>
        </div>
        <div className="connection-panel__row">
          <dt>Round-trip time</dt>
          <dd data-testid={`connection-rtt-${peer.membershipId}`}>{rtt ?? 'Connecting…'}</dd>
        </div>
        {peer.diagnostics?.localCandidateType ? (
          <div className="connection-panel__row">
            <dt>Local candidate</dt>
            <dd>{peer.diagnostics.localCandidateType}</dd>
          </div>
        ) : null}
        {peer.diagnostics?.remoteCandidateType ? (
          <div className="connection-panel__row">
            <dt>Remote candidate</dt>
            <dd>{peer.diagnostics.remoteCandidateType}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
