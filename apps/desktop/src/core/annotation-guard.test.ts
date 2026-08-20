import { beforeEach, describe, expect, it } from 'vitest';
import { createAnnotationGuard, type AnnotationGuard } from './annotation-guard';
import { CHANNEL_ANNOTATION, CHANNEL_CURSOR, CHANNEL_INPUT } from './data-channels';

/**
 * A guest does not draw, and that has to be true of a modified client too.
 *
 * The browser client omits `annotation-fast` from the channels it opens, but
 * the ids are negotiated and fixed: opening id 2 anyway takes a one-line
 * change to somebody else's copy of the client. Whether a stroke lands is
 * therefore decided here, on the receiving side, from the roster the control
 * plane sent.
 */
const KARL = 'mem_karl';
const WEB_GUEST = 'mem_webguest';

const begin = (membershipId: string) => ({
  type: 'stroke.begin',
  strokeId: 'str_1',
  membershipId,
  displayId: 'screen:1:0',
  colour: '#ff0000',
  width: 0.004,
});

const points = (membershipId: string) => ({
  type: 'stroke.points',
  strokeId: 'str_1',
  membershipId,
  index: 0,
  points: [{ x: 0.5, y: 0.5 }],
});

const clear = (membershipId: string) => ({ type: 'stroke.clear', membershipId });

describe('the drawing guard', () => {
  let guard: AnnotationGuard;

  beforeEach(() => {
    guard = createAnnotationGuard({ isGuestMembership: (id) => id === WEB_GUEST });
  });

  it('accepts a member drawing on the drawing channel', () => {
    const decision = guard.accept(begin(KARL), {
      membershipId: KARL,
      channel: CHANNEL_ANNOTATION,
    });
    expect(decision).toMatchObject({ accepted: true });
  });

  it('ignores every drawing message from a guest', () => {
    for (const message of [begin(WEB_GUEST), points(WEB_GUEST), clear(WEB_GUEST)]) {
      expect(
        guard.accept(message, { membershipId: WEB_GUEST, channel: CHANNEL_ANNOTATION }),
      ).toEqual({ accepted: false, reason: 'guest' });
    }
  });

  it('does not let a guest draw as somebody else', () => {
    // The claim in the payload is not the identity: it is decided by which
    // peer connection the message arrived on.
    expect(
      guard.accept(begin(KARL), { membershipId: WEB_GUEST, channel: CHANNEL_ANNOTATION }),
    ).toEqual({ accepted: false, reason: 'membership-mismatch' });
  });

  it('refuses drawing that arrives on another channel', () => {
    for (const channel of [CHANNEL_CURSOR, CHANNEL_INPUT]) {
      expect(guard.accept(begin(KARL), { membershipId: KARL, channel })).toEqual({
        accepted: false,
        reason: 'wrong-channel',
      });
    }
  });

  it('refuses anything it cannot read, without throwing', () => {
    for (const junk of [undefined, null, {}, { type: 'stroke.nope' }, { type: 'stroke.begin' }]) {
      expect(guard.accept(junk, { membershipId: KARL, channel: CHANNEL_ANNOTATION })).toEqual({
        accepted: false,
        reason: 'malformed',
      });
    }
  });

  it('asks the roster on every message, so a guest who arrives mid-call is one', () => {
    const guests = new Set<string>();
    const live = createAnnotationGuard({ isGuestMembership: (id) => guests.has(id) });
    expect(live.accept(begin(KARL), { membershipId: KARL, channel: CHANNEL_ANNOTATION })).toMatchObject({
      accepted: true,
    });

    guests.add(KARL);
    expect(live.accept(begin(KARL), { membershipId: KARL, channel: CHANNEL_ANNOTATION })).toEqual({
      accepted: false,
      reason: 'guest',
    });
  });
});
