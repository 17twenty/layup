import { describe, expect, it } from 'vitest';
import {
  MAX_POINTS_PER_MESSAGE,
  MAX_POINTS_PER_STROKE,
  TYPE_STROKE_BEGIN,
  TYPE_STROKE_CLEAR,
  TYPE_STROKE_END,
  TYPE_STROKE_POINTS,
  createStrokeAssembler,
  decodeDrawing,
  strokePoints,
} from './drawing';
import { ValidationError } from './validate';

const begin = (strokeId = 's1', membershipId = 'mem_a') => ({
  type: TYPE_STROKE_BEGIN as typeof TYPE_STROKE_BEGIN,
  strokeId,
  membershipId,
  displayId: 'display-1',
  colour: '#5b8def',
  width: 0.004,
});

const points = (index: number, xs: number[], strokeId = 's1', membershipId = 'mem_a') => ({
  type: TYPE_STROKE_POINTS as typeof TYPE_STROKE_POINTS,
  strokeId,
  membershipId,
  index,
  points: xs.map((x) => ({ x, y: 0.5 })),
});

const end = (totalPoints: number, strokeId = 's1', membershipId = 'mem_a') => ({
  type: TYPE_STROKE_END as typeof TYPE_STROKE_END,
  strokeId,
  membershipId,
  totalPoints,
});

describe('drawing protocol', () => {
  it('reconstructs a stroke in order even when messages arrive out of order', () => {
    const assembler = createStrokeAssembler();
    assembler.apply(begin());
    // Deliberately reversed: the channel is unordered.
    assembler.apply(points(2, [0.3]));
    assembler.apply(points(0, [0.1, 0.2]));
    assembler.apply(end(3));

    const [stroke] = assembler.strokes();
    expect(stroke?.points.map((point) => point.x)).toEqual([0.1, 0.2, 0.3]);
    expect(stroke).toMatchObject({ complete: true, hasGap: false, colour: '#5b8def' });
  });

  it('reports a gap rather than drawing a wrong line through it', () => {
    const assembler = createStrokeAssembler();
    assembler.apply(begin());
    assembler.apply(points(0, [0.1, 0.2]));
    // The message carrying index 2 was lost.
    assembler.apply(end(3));

    const [stroke] = assembler.strokes();
    expect(stroke?.points).toHaveLength(2);
    expect(stroke?.hasGap).toBe(true);
  });

  it('bounds message and stroke size', () => {
    const tooManyPoints = points(0, Array.from({ length: MAX_POINTS_PER_MESSAGE + 1 }, () => 0.5));
    expect(() => strokePoints(tooManyPoints)).toThrow(ValidationError);
    expect(() => strokePoints({ ...points(0, [0.5]), index: MAX_POINTS_PER_STROKE + 1 })).toThrow(
      ValidationError,
    );

    // A runaway sender cannot grow a single stroke without limit.
    const assembler = createStrokeAssembler();
    assembler.apply(begin());
    for (let index = 0; index < MAX_POINTS_PER_STROKE + 500; index += 1) {
      assembler.apply(points(index, [0.5]));
    }
    expect(assembler.strokes()[0]!.points.length).toBeLessThanOrEqual(MAX_POINTS_PER_STROKE);
  });

  it('rejects malformed messages instead of coercing them', () => {
    expect(() => decodeDrawing({ type: 'stroke.sneak' })).toThrow();
    expect(() => decodeDrawing({ ...begin(), width: 5 })).toThrow(ValidationError);
    expect(() => decodeDrawing({ ...points(0, [1.5]) })).toThrow(ValidationError);
    expect(() => decodeDrawing({ ...end(1), totalPoints: -1 })).toThrow(ValidationError);
    expect(() => decodeDrawing({ ...begin(), extra: true })).toThrow(ValidationError);
  });

  it('ignores points for a stroke it never saw begin', () => {
    const assembler = createStrokeAssembler();
    assembler.apply(points(0, [0.1]));
    expect(assembler.strokes()).toHaveLength(0);
  });

  it('ignores points attributed to a different membership', () => {
    const assembler = createStrokeAssembler();
    assembler.apply(begin('s1', 'mem_a'));
    // Someone else claiming to extend my stroke.
    assembler.apply(points(0, [0.9], 's1', 'mem_b'));
    expect(assembler.strokes()[0]?.points).toHaveLength(0);
  });

  it('clears everything, or just one participant', () => {
    const assembler = createStrokeAssembler();
    assembler.apply(begin('s1', 'mem_a'));
    assembler.apply(begin('s2', 'mem_b'));

    assembler.apply({ type: TYPE_STROKE_CLEAR, membershipId: 'mem_a', targetMembershipId: 'mem_a' });
    expect(assembler.strokes().map((stroke) => stroke.strokeId)).toEqual(['s2']);

    assembler.apply({ type: TYPE_STROKE_CLEAR, membershipId: 'mem_b' });
    expect(assembler.strokes()).toHaveLength(0);
  });

  it('bounds how many strokes it will hold', () => {
    const assembler = createStrokeAssembler({ maxStrokes: 3 });
    for (let i = 0; i < 10; i += 1) assembler.apply(begin(`s${i}`));
    expect(assembler.strokes().length).toBeLessThanOrEqual(3);
  });
});
