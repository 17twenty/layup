import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RouteDiagnostics } from '../../core/ice-diagnostics';
import { ConnectionReadout, routeLabel } from './ConnectionReadout';

const direct: RouteDiagnostics = {
  route: 'direct',
  relayed: false,
  localCandidateType: 'host',
  remoteCandidateType: 'host',
  rttMs: 18.4,
};

const relay: RouteDiagnostics = {
  route: 'relay',
  relayed: true,
  localCandidateType: 'relay',
  remoteCandidateType: 'srflx',
  rttMs: 142.9,
};

function track(settings: Partial<MediaTrackSettings>) {
  return { getSettings: () => settings } as unknown as MediaStreamTrack;
}

const karl = { membershipId: 'mem_karl', label: 'Karl', diagnostics: direct };
const sam = { membershipId: 'mem_guest', label: 'Sam', diagnostics: relay };

describe('routeLabel', () => {
  it('renders every route in plain words, not the raw enum', () => {
    expect(routeLabel('direct')).toBe('Direct');
    expect(routeLabel('relay')).toBe('Relayed');
    expect(routeLabel('reflexive')).toBe('Direct (NAT)');
    expect(routeLabel('unknown')).toBe('Unknown');
    expect(routeLabel(undefined)).toBe('Unknown');
  });
});

describe('the connection chip', () => {
  it('never shows an empty box before the first sample lands', () => {
    render(<ConnectionReadout expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-chip')).toHaveTextContent('Connecting…');
  });

  it('renders the route in plain words', () => {
    render(<ConnectionReadout peers={[karl]} expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-chip')).toHaveTextContent('Direct');
  });

  it('shows RTT in milliseconds', () => {
    render(<ConnectionReadout peers={[karl]} expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-chip')).toHaveTextContent('18 ms');
  });

  it('is visually distinct when relayed, because that explains the latency', () => {
    render(<ConnectionReadout peers={[sam]} expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-chip')).toHaveClass('connection-chip--relay');
  });

  it('is not marked relayed for a direct route', () => {
    render(<ConnectionReadout peers={[karl]} expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-chip')).not.toHaveClass('connection-chip--relay');
  });

  it('expands to the full panel on click', async () => {
    const onToggle = vi.fn();
    render(<ConnectionReadout peers={[karl]} expanded={false} onToggle={onToggle} />);
    expect(screen.queryByTestId('connection-panel')).toBeNull();
    await userEvent.click(screen.getByTestId('connection-chip'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  /**
   * With more than one person in the call the chip has one line to summarise
   * several links, and the only summary that cannot mislead is the worst one.
   * Reporting "Direct 18 ms" while somebody else is on a relay - or has no
   * route at all - says the call is fine when it is not for everybody.
   */
  it('summarises the worst link, not an arbitrary one', () => {
    render(<ConnectionReadout peers={[karl, sam]} expanded={false} onToggle={vi.fn()} />);
    const chip = screen.getByTestId('connection-chip');
    expect(chip).toHaveTextContent('Relayed');
    expect(chip).toHaveTextContent('143 ms');
    expect(chip).toHaveClass('connection-chip--relay');
    // And says how many links it is standing in for, so the number is not
    // mistaken for the whole story.
    expect(chip).toHaveTextContent('2 links');
  });

  it('reports a link with no sample yet as connecting, whoever else is fine', () => {
    render(
      <ConnectionReadout
        peers={[karl, { membershipId: 'mem_guest', label: 'Sam' }]}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId('connection-chip')).toHaveTextContent('Connecting…');
  });
});

describe('the full panel', () => {
  it('says Connecting… rather than leaving the box blank', () => {
    render(<ConnectionReadout expanded onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-panel')).toHaveTextContent('Connecting…');
  });

  it('shows route, RTT and candidate types', () => {
    render(<ConnectionReadout peers={[karl]} expanded onToggle={vi.fn()} />);
    const row = screen.getByTestId('connection-peer-mem_karl');
    expect(screen.getByTestId('connection-route-mem_karl')).toHaveTextContent('Direct');
    expect(screen.getByTestId('connection-rtt-mem_karl')).toHaveTextContent('18 ms');
    expect(row).toHaveTextContent('host');
  });

  /**
   * The question this panel exists to answer is "whose link is bad", and it
   * could not be asked of it: one `RouteDiagnostics` went in, nothing said
   * whose, and with a guest in the call it was whichever peer happened to be
   * first.
   */
  it('gives every peer a row of their own, labelled with who it is', () => {
    render(<ConnectionReadout peers={[karl, sam]} expanded onToggle={vi.fn()} />);

    expect(screen.getByTestId('connection-peer-mem_karl')).toHaveTextContent('Karl');
    expect(screen.getByTestId('connection-route-mem_karl')).toHaveTextContent('Direct');
    expect(screen.getByTestId('connection-peer-mem_guest')).toHaveTextContent('Sam');
    expect(screen.getByTestId('connection-route-mem_guest')).toHaveTextContent('Relayed');
    expect(screen.getByTestId('connection-rtt-mem_guest')).toHaveTextContent('143 ms');
  });

  it('says Connecting… for the one peer that has no sample, and numbers for the rest', () => {
    render(
      <ConnectionReadout
        peers={[karl, { membershipId: 'mem_guest', label: 'Sam' }]}
        expanded
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId('connection-rtt-mem_karl')).toHaveTextContent('18 ms');
    expect(screen.getByTestId('connection-rtt-mem_guest')).toHaveTextContent('Connecting…');
  });

  it('reads resolution and framerate off the incoming video track', () => {
    render(
      <ConnectionReadout
        peers={[karl]}
        videoTrack={track({ width: 1920, height: 1080, frameRate: 30 })}
        expanded
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId('connection-resolution')).toHaveTextContent('1920×1080');
    expect(screen.getByTestId('connection-framerate')).toHaveTextContent('30 fps');
  });

  it('omits resolution and framerate when no track is available', () => {
    render(<ConnectionReadout peers={[karl]} expanded onToggle={vi.fn()} />);
    expect(screen.queryByTestId('connection-resolution')).toBeNull();
    expect(screen.queryByTestId('connection-framerate')).toBeNull();
  });

  it('explains a relayed route rather than just labelling it', () => {
    render(<ConnectionReadout peers={[sam]} expanded onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-relay-note')).toBeInTheDocument();
  });

  it('says nothing extra about a direct route', () => {
    render(<ConnectionReadout peers={[karl]} expanded onToggle={vi.fn()} />);
    expect(screen.queryByTestId('connection-relay-note')).toBeNull();
  });
});
