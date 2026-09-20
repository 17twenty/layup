/**
 * The gate every incoming drawing message passes before it becomes a stroke on
 * anybody's overlay (SPEC.md §9, the web-guests design §8).
 *
 * A guest does not draw. The browser client says so by never opening
 * `annotation-fast` (`apps/web/src/useGuestRoom.ts`), but that is the *sender*
 * choosing to behave: the channel ids are negotiated and fixed, so a modified
 * client can open id 2 and draw anyway. A limit only a client enforces is a
 * product statement, not a control.
 *
 * So the refusal lives on the receiving side as well, exactly as it does for
 * remote input (`input-guard.ts`): what a peer may do is decided from state
 * this machine owns - the roster the control plane sent - and never from what
 * the message claims about itself.
 *
 * Drawing is not dangerous the way control is; nobody's machine is touched by
 * a stroke. It is here because a stated limit a client can ignore makes every
 * other stated limit less believable.
 */
import { decodeDrawing, type DrawingMessage } from '@layup/protocol';
import { CHANNEL_ANNOTATION } from './data-channels';

/** Why a drawing message was ignored. Never echoes the payload. */
export type AnnotationRefusalReason =
  | 'wrong-channel'
  | 'malformed'
  | 'membership-mismatch'
  | 'guest';

export type AnnotationDecision =
  | { accepted: true; message: DrawingMessage }
  | { accepted: false; reason: AnnotationRefusalReason };

export interface AnnotationGuardOptions {
  /**
   * Whether a membership belongs to a guest: a browser visitor who arrived by
   * link. Supplied by the caller from `ParticipantDTO.isGuest`, because the
   * wire carries membership ids and nothing else - this cannot answer it on
   * its own. Read on every message, so a roster that arrives mid-call governs
   * the next stroke.
   */
  isGuestMembership?: (membershipId: string) => boolean;
}

export interface AnnotationGuard {
  /** Judges one drawing message from one peer. */
  accept(raw: unknown, from: { membershipId: string; channel: string }): AnnotationDecision;
}

export function createAnnotationGuard(options: AnnotationGuardOptions = {}): AnnotationGuard {
  const refuse = (reason: AnnotationRefusalReason): AnnotationDecision => ({
    accepted: false,
    reason,
  });

  return {
    accept(raw, from) {
      // Drawing arrives on the drawing channel. Accepting a stroke from
      // `input-reliable` would mean accepting it from the channel that carries
      // grants and clicks (ADR-0008).
      if (from.channel !== CHANNEL_ANNOTATION) return refuse('wrong-channel');

      let message: DrawingMessage;
      try {
        message = decodeDrawing(raw);
      } catch {
        return refuse('malformed');
      }

      // Who you are is decided by which peer connection the message arrived
      // on, not by what the message says about itself - otherwise a guest
      // draws as somebody else and the check below means nothing.
      if (message.membershipId !== from.membershipId) return refuse('membership-mismatch');

      if (options.isGuestMembership?.(message.membershipId)) return refuse('guest');

      return { accepted: true, message };
    },
  };
}
