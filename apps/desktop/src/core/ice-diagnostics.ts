/**
 * ICE route diagnostics.
 *
 * "It connected" is not enough to reason about a call: PLAN-1 has to know
 * whether media went direct, through a reflexive path, or over TURN, because
 * the three feel different and fail differently (SPEC.md §10.3).
 */
export type IceRoute = 'direct' | 'reflexive' | 'relay' | 'unknown';

export interface RouteDiagnostics {
  route: IceRoute;
  localCandidateType?: string;
  remoteCandidateType?: string;
  transport?: string;
  /** Current round-trip time on the selected pair, in milliseconds. */
  rttMs?: number;
  availableOutgoingBitrate?: number;
  bytesSent?: number;
  bytesReceived?: number;
  /** True when either end is a TURN relay. */
  relayed: boolean;
}

interface StatsLike {
  forEach(callback: (report: Record<string, unknown>) => void): void;
  get?(id: string): Record<string, unknown> | undefined;
}

/**
 * Reads the selected candidate pair out of an RTCStatsReport.
 *
 * Browsers disagree about where the selected pair lives, so both the
 * `transport.selectedCandidatePairId` route and the `state === 'succeeded'`
 * fallback are handled.
 */
export function readRouteDiagnostics(stats: StatsLike): RouteDiagnostics {
  const byId = new Map<string, Record<string, unknown>>();
  let selectedPairId: string | undefined;
  let succeededPair: Record<string, unknown> | undefined;

  stats.forEach((report) => {
    const id = String(report.id ?? '');
    if (id) byId.set(id, report);
    if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
      selectedPairId = report.selectedCandidatePairId;
    }
    if (report.type === 'candidate-pair' && (report.selected === true || report.state === 'succeeded')) {
      // Prefer an explicitly selected pair; otherwise the last succeeded one.
      if (report.selected === true || !succeededPair) succeededPair = report;
    }
  });

  const pair = (selectedPairId ? byId.get(selectedPairId) : undefined) ?? succeededPair;
  if (!pair) return { route: 'unknown', relayed: false };

  const local = byId.get(String(pair.localCandidateId ?? ''));
  const remote = byId.get(String(pair.remoteCandidateId ?? ''));
  const localType = local?.candidateType as string | undefined;
  const remoteType = remote?.candidateType as string | undefined;
  const relayed = localType === 'relay' || remoteType === 'relay';

  const diagnostics: RouteDiagnostics = {
    route: classify(localType, remoteType),
    relayed,
  };
  if (localType) diagnostics.localCandidateType = localType;
  if (remoteType) diagnostics.remoteCandidateType = remoteType;
  if (typeof local?.protocol === 'string') diagnostics.transport = local.protocol;
  if (typeof pair.currentRoundTripTime === 'number') {
    diagnostics.rttMs = Math.round(pair.currentRoundTripTime * 1000 * 1000) / 1000;
  }
  if (typeof pair.availableOutgoingBitrate === 'number') {
    diagnostics.availableOutgoingBitrate = pair.availableOutgoingBitrate;
  }
  if (typeof pair.bytesSent === 'number') diagnostics.bytesSent = pair.bytesSent;
  if (typeof pair.bytesReceived === 'number') diagnostics.bytesReceived = pair.bytesReceived;
  return diagnostics;
}

function classify(localType?: string, remoteType?: string): IceRoute {
  if (!localType && !remoteType) return 'unknown';
  if (localType === 'relay' || remoteType === 'relay') return 'relay';
  if (localType === 'host' && (remoteType === 'host' || remoteType === undefined)) return 'direct';
  return 'reflexive';
}

/** A short human description for the connection indicator. */
export function describeRoute(diagnostics: RouteDiagnostics): string {
  switch (diagnostics.route) {
    case 'direct':
      return 'direct';
    case 'reflexive':
      return 'direct (via NAT)';
    case 'relay':
      return 'relayed through TURN';
    default:
      return 'route unknown';
  }
}
