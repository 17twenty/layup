import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CursorOverlay } from './CursorOverlay';
import type { RemoteCursor } from '../../core/cursor-receiver';

const cursor = (overrides: Partial<RemoteCursor> = {}): RemoteCursor => ({
  membershipId: 'mem_a',
  displayId: 'display-1',
  x: 0.25,
  y: 0.5,
  targetX: 0.25,
  targetY: 0.5,
  updatedAtMs: 0,
  ...overrides,
});

/** Drives frames by hand instead of waiting for requestAnimationFrame. */
function frames() {
  const pending: Array<() => void> = [];
  return {
    schedule: (callback: () => void) => {
      pending.push(callback);
      return pending.length;
    },
    cancel: () => {},
    run(times = 1) {
      for (let i = 0; i < times; i += 1) {
        const next = pending.shift();
        if (next) act(() => next());
      }
    },
  };
}

describe('cursor overlay', () => {
  it('positions cursors as a percentage, so they track a scaled screen', () => {
    const clock = frames();
    render(
      <CursorOverlay
        sample={() => [cursor({ x: 0.25, y: 0.5 })]}
        scheduleFrame={clock.schedule}
        cancelFrame={clock.cancel}
      />,
    );
    clock.run(2);

    const element = screen.getByTestId('cursor-mem_a');
    // Percentages rather than pixels: correct at any rendered video size.
    expect(element.style.left).toBe('25%');
    expect(element.style.top).toBe('50%');
  });

  it('never intercepts pointer events or moves the OS cursor', () => {
    const clock = frames();
    const view = render(
      <CursorOverlay sample={() => [cursor()]} scheduleFrame={clock.schedule} cancelFrame={clock.cancel} />,
    );
    clock.run(2);

    const overlay = screen.getByTestId('cursor-overlay');
    // Decorative and inert: it draws, it does not interact.
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(view.container.querySelector('button, a, input')).toBeNull();
  });

  it('redraws every frame, independently of how often packets arrive', () => {
    const clock = frames();
    const positions = [0.1, 0.2, 0.3];
    let index = 0;
    render(
      <CursorOverlay
        sample={() => [cursor({ x: positions[Math.min(index++, positions.length - 1)]! })]}
        scheduleFrame={clock.schedule}
        cancelFrame={clock.cancel}
      />,
    );

    clock.run(1);
    expect(screen.getByTestId('cursor-mem_a').dataset.x).toBe('0.1000');
    clock.run(1);
    expect(screen.getByTestId('cursor-mem_a').dataset.x).toBe('0.2000');
    clock.run(1);
    expect(screen.getByTestId('cursor-mem_a').dataset.x).toBe('0.3000');
  });

  it('distinguishes participants by colour and label', () => {
    const clock = frames();
    render(
      <CursorOverlay
        sample={() => [cursor({ membershipId: 'mem_a' }), cursor({ membershipId: 'mem_b', x: 0.8 })]}
        identify={(id) =>
          id === 'mem_a' ? { colour: '#6fd18a', label: 'Nick' } : { colour: '#f0805a', label: 'Karl' }
        }
        scheduleFrame={clock.schedule}
        cancelFrame={clock.cancel}
      />,
    );
    clock.run(2);

    expect(screen.getByTestId('cursor-mem_a').style.color).toBe('rgb(111, 209, 138)');
    expect(screen.getByTestId('cursor-mem_b').style.color).toBe('rgb(240, 128, 90)');
    expect(screen.getByText('Nick')).toBeTruthy();
    expect(screen.getByText('Karl')).toBeTruthy();
  });

  it('stops drawing when unmounted', () => {
    const clock = frames();
    const sample = vi.fn(() => [cursor()]);
    const view = render(
      <CursorOverlay sample={sample} scheduleFrame={clock.schedule} cancelFrame={clock.cancel} />,
    );
    clock.run(2);
    const callsBefore = sample.mock.calls.length;

    view.unmount();
    clock.run(2);
    expect(sample.mock.calls.length).toBe(callsBefore);
  });
});
