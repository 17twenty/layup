/**
 * Drawing protocol (SPEC.md §9, ADR-0008).
 *
 *   stroke.begin   stroke.points   stroke.end   stroke.clear
 *
 * Drawing is a data-plane feature: strokes are vectors on an overlay, never
 * pixels baked into the shared video, so they stay crisp and cost the encoder
 * nothing.
 *
 * The channel is loss-tolerant, so each `stroke.points` carries its own index
 * within the stroke. A gap is therefore visible rather than silently producing
 * a wrong line, and points can be reassembled in order even if they arrive out
 * of order.
 */
import {
  isArrayOf,
  isEnum,
  isInteger,
  isNormalised,
  isObject,
  isString,
  optional,
  type Validator,
} from './validate';

export const TYPE_STROKE_BEGIN = 'stroke.begin';
export const TYPE_STROKE_POINTS = 'stroke.points';
export const TYPE_STROKE_END = 'stroke.end';
export const TYPE_STROKE_CLEAR = 'stroke.clear';

/** Bounds chosen so one message stays comfortably inside an SCTP datagram. */
export const MAX_POINTS_PER_MESSAGE = 64;
/** A stroke longer than this is a runaway sender, not a drawing. */
export const MAX_POINTS_PER_STROKE = 4096;

const point = isObject({ x: isNormalised, y: isNormalised });
export type StrokePoint = ReturnType<typeof point>;

export const strokeBegin = isObject({
  type: isEnum([TYPE_STROKE_BEGIN] as const),
  strokeId: isString,
  membershipId: isString,
  displayId: isString,
  colour: isString,
  /** Normalised so a stroke is the same thickness on any receiver. */
  width: isNormalised,
});
export type StrokeBegin = ReturnType<typeof strokeBegin>;

export const strokePoints = isObject({
  type: isEnum([TYPE_STROKE_POINTS] as const),
  strokeId: isString,
  membershipId: isString,
  /** Index of the first point in this message within the stroke. */
  index: isInteger({ min: 0, max: MAX_POINTS_PER_STROKE }),
  points: isArrayOf(point, { max: MAX_POINTS_PER_MESSAGE }),
});
export type StrokePoints = ReturnType<typeof strokePoints>;

export const strokeEnd = isObject({
  type: isEnum([TYPE_STROKE_END] as const),
  strokeId: isString,
  membershipId: isString,
  /** How many points the stroke should have, so a receiver can spot a gap. */
  totalPoints: isInteger({ min: 0, max: MAX_POINTS_PER_STROKE }),
});
export type StrokeEnd = ReturnType<typeof strokeEnd>;

export const strokeClear = isObject({
  type: isEnum([TYPE_STROKE_CLEAR] as const),
  membershipId: isString,
  /** Absent clears everything; present clears only that membership's strokes. */
  targetMembershipId: optional(isString),
});
export type StrokeClear = ReturnType<typeof strokeClear>;

export type DrawingMessage = StrokeBegin | StrokePoints | StrokeEnd | StrokeClear;

const VALIDATORS: Record<string, Validator<DrawingMessage>> = {
  [TYPE_STROKE_BEGIN]: strokeBegin as Validator<DrawingMessage>,
  [TYPE_STROKE_POINTS]: strokePoints as Validator<DrawingMessage>,
  [TYPE_STROKE_END]: strokeEnd as Validator<DrawingMessage>,
  [TYPE_STROKE_CLEAR]: strokeClear as Validator<DrawingMessage>,
};

/** Validates any drawing message by its `type`. Throws on anything unknown. */
export function decodeDrawing(raw: unknown): DrawingMessage {
  const type = (raw as { type?: unknown })?.type;
  const validator = typeof type === 'string' ? VALIDATORS[type] : undefined;
  if (!validator) {
    throw new (class extends Error {})(`unknown drawing message ${String(type)}`);
  }
  return validator(raw, String(type));
}

/** A stroke being assembled from messages that may arrive out of order. */
export interface AssembledStroke {
  strokeId: string;
  membershipId: string;
  displayId: string;
  colour: string;
  width: number;
  points: StrokePoint[];
  complete: boolean;
  /** True when the stroke ended with fewer points than promised. */
  hasGap: boolean;
}

export interface StrokeAssembler {
  apply(message: DrawingMessage): void;
  strokes(): AssembledStroke[];
  clear(membershipId?: string): void;
}

/**
 * Reassembles strokes.
 *
 * `stroke.points` messages are placed by index, so ordering within a stroke is
 * reconstructed regardless of arrival order, and a dropped message leaves a
 * detectable gap rather than a straight line through the missing section.
 */
export function createStrokeAssembler(options: { maxStrokes?: number } = {}): StrokeAssembler {
  const maxStrokes = options.maxStrokes ?? 500;
  const open = new Map<string, AssembledStroke & { received: Map<number, StrokePoint>; expected?: number }>();

  const finalise = (stroke: (typeof open) extends Map<string, infer V> ? V : never) => {
    const indices = [...stroke.received.keys()].sort((a, b) => a - b);
    stroke.points = indices.map((index) => stroke.received.get(index)!);
    stroke.hasGap = stroke.expected !== undefined && stroke.points.length < stroke.expected;
  };

  return {
    apply(message) {
      switch (message.type) {
        case TYPE_STROKE_BEGIN: {
          if (open.size >= maxStrokes) {
            // A sender that never ends its strokes must not grow us without limit.
            const oldest = open.keys().next().value;
            if (oldest) open.delete(oldest);
          }
          open.set(message.strokeId, {
            strokeId: message.strokeId,
            membershipId: message.membershipId,
            displayId: message.displayId,
            colour: message.colour,
            width: message.width,
            points: [],
            complete: false,
            hasGap: false,
            received: new Map(),
          });
          return;
        }
        case TYPE_STROKE_POINTS: {
          const stroke = open.get(message.strokeId);
          // Points for a stroke we never saw begin are dropped: we do not know
          // its colour, width or display.
          if (!stroke || stroke.membershipId !== message.membershipId) return;
          message.points.forEach((entry, offset) => {
            if (stroke.received.size >= MAX_POINTS_PER_STROKE) return;
            stroke.received.set(message.index + offset, entry);
          });
          finalise(stroke);
          return;
        }
        case TYPE_STROKE_END: {
          const stroke = open.get(message.strokeId);
          if (!stroke || stroke.membershipId !== message.membershipId) return;
          stroke.expected = message.totalPoints;
          stroke.complete = true;
          finalise(stroke);
          return;
        }
        case TYPE_STROKE_CLEAR: {
          this.clear(message.targetMembershipId);
          return;
        }
      }
    },

    strokes: () =>
      [...open.values()].map(({ received: _received, expected: _expected, ...stroke }) => ({ ...stroke })),

    clear(membershipId) {
      if (!membershipId) {
        open.clear();
        return;
      }
      for (const [strokeId, stroke] of [...open.entries()]) {
        if (stroke.membershipId === membershipId) open.delete(strokeId);
      }
    },
  };
}
