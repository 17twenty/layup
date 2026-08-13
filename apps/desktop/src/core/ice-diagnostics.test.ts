import { describe, expect, it } from 'vitest';
import { describeRoute, readRouteDiagnostics } from './ice-diagnostics';

function stats(reports: Array<Record<string, unknown>>) {
  return {
    forEach(callback: (report: Record<string, unknown>) => void) {
      reports.forEach(callback);
    },
  };
}

const pair = (overrides: Record<string, unknown> = {}) => ({
  id: 'pair-1',
  type: 'candidate-pair',
  state: 'succeeded',
  localCandidateId: 'local-1',
  remoteCandidateId: 'remote-1',
  currentRoundTripTime: 0.012,
  availableOutgoingBitrate: 1_200_000,
  bytesSent: 4096,
  bytesReceived: 2048,
  ...overrides,
});

describe('ICE route diagnostics', () => {
  it('reports a direct host-to-host route', () => {
    const diagnostics = readRouteDiagnostics(
      stats([
        pair(),
        { id: 'local-1', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
        { id: 'remote-1', type: 'remote-candidate', candidateType: 'host' },
      ]),
    );

    expect(diagnostics).toMatchObject({
      route: 'direct',
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      transport: 'udp',
      relayed: false,
      rttMs: 12,
      availableOutgoingBitrate: 1_200_000,
      bytesSent: 4096,
    });
    expect(describeRoute(diagnostics)).toBe('direct');
  });

  it('reports a reflexive route through NAT', () => {
    const diagnostics = readRouteDiagnostics(
      stats([
        pair(),
        { id: 'local-1', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
        { id: 'remote-1', type: 'remote-candidate', candidateType: 'host' },
      ]),
    );
    expect(diagnostics.route).toBe('reflexive');
    expect(diagnostics.relayed).toBe(false);
    expect(describeRoute(diagnostics)).toBe('direct (via NAT)');
  });

  it('reports a relayed route when either end is TURN', () => {
    const localRelay = readRouteDiagnostics(
      stats([
        pair(),
        { id: 'local-1', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' },
        { id: 'remote-1', type: 'remote-candidate', candidateType: 'srflx' },
      ]),
    );
    expect(localRelay).toMatchObject({ route: 'relay', relayed: true });
    expect(describeRoute(localRelay)).toBe('relayed through TURN');

    const remoteRelay = readRouteDiagnostics(
      stats([
        pair(),
        { id: 'local-1', type: 'local-candidate', candidateType: 'host' },
        { id: 'remote-1', type: 'remote-candidate', candidateType: 'relay' },
      ]),
    );
    expect(remoteRelay.relayed).toBe(true);
  });

  it('prefers the pair the transport says is selected', () => {
    const diagnostics = readRouteDiagnostics(
      stats([
        { id: 'transport-1', type: 'transport', selectedCandidatePairId: 'pair-2' },
        pair({ id: 'pair-1', localCandidateId: 'local-1' }),
        pair({ id: 'pair-2', localCandidateId: 'local-2', remoteCandidateId: 'remote-2' }),
        { id: 'local-1', type: 'local-candidate', candidateType: 'relay' },
        { id: 'local-2', type: 'local-candidate', candidateType: 'host' },
        { id: 'remote-2', type: 'remote-candidate', candidateType: 'host' },
      ]),
    );
    expect(diagnostics.route).toBe('direct');
  });

  it('says unknown rather than guessing when nothing has succeeded', () => {
    const diagnostics = readRouteDiagnostics(
      stats([{ id: 'pair-1', type: 'candidate-pair', state: 'in-progress' }]),
    );
    expect(diagnostics).toEqual({ route: 'unknown', relayed: false });
    expect(describeRoute(diagnostics)).toBe('route unknown');
  });
});
