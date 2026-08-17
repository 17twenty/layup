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
    render(<ConnectionReadout diagnostics={direct} expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-chip')).toHaveTextContent('Direct');
  });

  it('shows RTT in milliseconds', () => {
    render(<ConnectionReadout diagnostics={direct} expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-chip')).toHaveTextContent('18 ms');
  });

  it('is visually distinct when relayed, because that explains the latency', () => {
    render(<ConnectionReadout diagnostics={relay} expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-chip')).toHaveClass('connection-chip--relay');
  });

  it('is not marked relayed for a direct route', () => {
    render(<ConnectionReadout diagnostics={direct} expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-chip')).not.toHaveClass('connection-chip--relay');
  });

  it('expands to the full panel on click', async () => {
    const onToggle = vi.fn();
    render(<ConnectionReadout diagnostics={direct} expanded={false} onToggle={onToggle} />);
    expect(screen.queryByTestId('connection-panel')).toBeNull();
    await userEvent.click(screen.getByTestId('connection-chip'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('the full panel', () => {
  it('says Connecting… rather than leaving the box blank', () => {
    render(<ConnectionReadout expanded onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-panel')).toHaveTextContent('Connecting…');
  });

  it('shows route, RTT and candidate types', () => {
    render(<ConnectionReadout diagnostics={direct} expanded onToggle={vi.fn()} />);
    const panel = screen.getByTestId('connection-panel');
    expect(screen.getByTestId('connection-route')).toHaveTextContent('Direct');
    expect(screen.getByTestId('connection-rtt')).toHaveTextContent('18 ms');
    expect(panel).toHaveTextContent('host');
  });

  it('reads resolution and framerate off the incoming video track', () => {
    render(
      <ConnectionReadout
        diagnostics={direct}
        videoTrack={track({ width: 1920, height: 1080, frameRate: 30 })}
        expanded
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId('connection-resolution')).toHaveTextContent('1920×1080');
    expect(screen.getByTestId('connection-framerate')).toHaveTextContent('30 fps');
  });

  it('omits resolution and framerate when no track is available', () => {
    render(<ConnectionReadout diagnostics={direct} expanded onToggle={vi.fn()} />);
    expect(screen.queryByTestId('connection-resolution')).toBeNull();
    expect(screen.queryByTestId('connection-framerate')).toBeNull();
  });

  it('explains a relayed route rather than just labelling it', () => {
    render(<ConnectionReadout diagnostics={relay} expanded onToggle={vi.fn()} />);
    expect(screen.getByTestId('connection-relay-note')).toBeInTheDocument();
  });

  it('says nothing extra about a direct route', () => {
    render(<ConnectionReadout diagnostics={direct} expanded onToggle={vi.fn()} />);
    expect(screen.queryByTestId('connection-relay-note')).toBeNull();
  });
});
