import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DrawingOverlay } from './DrawingOverlay';
import { createStrokeAssembler, type AssembledStroke } from '@layup/protocol';

const stroke = (overrides: Partial<AssembledStroke> = {}): AssembledStroke => ({
  strokeId: 's1',
  membershipId: 'mem_a',
  displayId: 'display-1',
  colour: '#5b8def',
  width: 0.004,
  points: [
    { x: 0.1, y: 0.2 },
    { x: 0.3, y: 0.4 },
  ],
  complete: true,
  hasGap: false,
  ...overrides,
});

describe('drawing overlay', () => {
  it('renders a stroke as a vector path over the video', () => {
    render(<DrawingOverlay strokes={[stroke()]} />);

    const path = screen.getByTestId('stroke-s1');
    expect(path).toHaveAttribute('d', 'M 0.1 0.2 L 0.3 0.4');
    expect(path).toHaveAttribute('stroke', '#5b8def');
    // Vectors, not pixels: nothing here can reach the encoder.
    expect(path.tagName.toLowerCase()).toBe('path');
  });

  it('scales with the screen without any resize handling', () => {
    render(<DrawingOverlay strokes={[stroke()]} />);
    const svg = screen.getByTestId('drawing-overlay');

    // A normalised viewBox means the same markup is correct at every size.
    expect(svg).toHaveAttribute('viewBox', '0 0 1 1');
    expect(svg).toHaveAttribute('preserveAspectRatio', 'none');
  });

  it('renders a single-point stroke as a visible dot', () => {
    render(<DrawingOverlay strokes={[stroke({ points: [{ x: 0.5, y: 0.5 }] })]} />);
    expect(screen.getByTestId('stroke-s1')).toHaveAttribute('d', 'M 0.5 0.5 l 0.0001 0');
  });

  it('colours a stroke by its author so it matches their cursor', () => {
    render(
      <DrawingOverlay
        strokes={[stroke({ membershipId: 'mem_b' })]}
        identify={() => ({ colour: '#f0805a' })}
      />,
    );
    expect(screen.getByTestId('stroke-s1')).toHaveAttribute('stroke', '#f0805a');
  });

  it('marks a stroke with a gap rather than hiding the loss', () => {
    render(<DrawingOverlay strokes={[stroke({ hasGap: true })]} />);
    expect(screen.getByTestId('stroke-s1')).toHaveAttribute('data-gap', 'true');
  });

  it('draws nothing when there is nothing to draw', () => {
    render(<DrawingOverlay strokes={[stroke({ points: [] })]} />);
    expect(screen.queryByTestId('stroke-s1')).toBeNull();
    expect(screen.getByTestId('drawing-overlay')).toBeTruthy();
  });

  it('clearing annotations empties the overlay', () => {
    // The clear action is a protocol message; the overlay simply reflects it.
    const assembler = createStrokeAssembler();
    assembler.apply({
      type: 'stroke.begin',
      strokeId: 's1',
      membershipId: 'mem_a',
      displayId: 'display-1',
      colour: '#5b8def',
      width: 0.004,
    });
    assembler.apply({
      type: 'stroke.points',
      strokeId: 's1',
      membershipId: 'mem_a',
      index: 0,
      points: [{ x: 0.1, y: 0.1 }],
    });

    const view = render(<DrawingOverlay strokes={assembler.strokes()} />);
    expect(screen.getByTestId('stroke-s1')).toBeTruthy();

    assembler.apply({ type: 'stroke.clear', membershipId: 'mem_a' });
    view.rerender(<DrawingOverlay strokes={assembler.strokes()} />);
    expect(screen.queryByTestId('stroke-s1')).toBeNull();
  });
});
