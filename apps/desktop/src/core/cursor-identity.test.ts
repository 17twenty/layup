import { describe, expect, it } from 'vitest';
import { CURSOR_COLOURS, createCursorIdentityBook } from './cursor-identity';
import { createCursorReceiver } from './cursor-receiver';
import type { Participant } from './control-client';
import type { CursorMove } from '@layup/protocol';

const participant = (membershipId: string, displayName: string, leftAt?: string): Participant => ({
  membershipId,
  userId: `usr_${displayName.toLowerCase()}`,
  displayName,
  joinedAt: '2026-08-14T09:00:00Z',
  isCreatorMembership: false,
  ...(leftAt ? { leftAt } : {}),
});

const move = (membershipId: string, seq: number, x: number): CursorMove => ({
  type: 'cursor.move',
  membershipId,
  displayId: 'display-1',
  x,
  y: 0.5,
  seq,
});

describe('participant cursor identity', () => {
  it('gives each participant a distinct colour and their own name', () => {
    const book = createCursorIdentityBook();
    book.sync([participant('mem_a', 'Nick'), participant('mem_b', 'Karl'), participant('mem_c', 'Emelia')]);

    const identities = ['mem_a', 'mem_b', 'mem_c'].map((id) => book.identify(id));
    expect(identities.map((identity) => identity.label)).toEqual(['Nick', 'Karl', 'Emelia']);
    // Colour alone is never the only signal, but it must still be distinct.
    expect(new Set(identities.map((identity) => identity.colour)).size).toBe(3);
    expect(identities.every((identity) => CURSOR_COLOURS.includes(identity.colour as never))).toBe(true);
  });

  it('leaves your own cursor out: you already have a real pointer', () => {
    const book = createCursorIdentityBook({ selfMembershipId: 'mem_self' });
    book.sync([participant('mem_self', 'Nick'), participant('mem_b', 'Karl')]);

    expect(book.retired()).not.toContain('mem_b');
    expect(book.identify('mem_b').label).toBe('Karl');
    // Self was never registered, so syncing again does not "retire" it either.
    book.sync([participant('mem_self', 'Nick'), participant('mem_b', 'Karl')]);
    expect(book.retired()).toEqual([]);
  });

  it('retires a cursor promptly when its membership leaves', () => {
    const book = createCursorIdentityBook();
    book.sync([participant('mem_a', 'Nick'), participant('mem_b', 'Karl')]);

    book.sync([participant('mem_a', 'Nick'), participant('mem_b', 'Karl', '2026-08-14T09:05:00Z')]);
    expect(book.retired()).toEqual(['mem_b']);

    // And it is gone from the book, not merely marked.
    book.sync([participant('mem_a', 'Nick')]);
    expect(book.retired()).toEqual([]);
  });

  it('does not reuse stale cursor state when the same person rejoins', () => {
    const book = createCursorIdentityBook();
    const receiver = createCursorReceiver({ now: () => 0 });

    book.sync([participant('mem_first', 'Karl')]);
    receiver.apply(move('mem_first', 500, 0.9));
    expect(receiver.sample()[0]?.targetX).toBe(0.9);

    // Karl leaves: his membership ends and its cursor goes with it.
    book.sync([]);
    for (const membershipId of book.retired()) receiver.remove(membershipId);
    expect(receiver.sample()).toHaveLength(0);

    // Karl rejoins - a *new* membership id, so nothing is inherited: not the
    // colour slot, not the position, not the sequence number.
    book.sync([participant('mem_second', 'Karl')]);
    expect(receiver.apply(move('mem_second', 1, 0.1))).toBe(true);
    expect(receiver.sample()[0]?.targetX).toBe(0.1);
    expect(book.identify('mem_second').colour).toBe(CURSOR_COLOURS[0]);
  });

  it('reuses a freed colour rather than drifting through the palette', () => {
    const book = createCursorIdentityBook();
    book.sync([participant('mem_a', 'Nick'), participant('mem_b', 'Karl')]);
    const karlColour = book.identify('mem_b').colour;

    book.sync([participant('mem_a', 'Nick')]);
    book.sync([participant('mem_a', 'Nick'), participant('mem_c', 'Priya')]);

    expect(book.identify('mem_c').colour).toBe(karlColour);
    expect(book.identify('mem_c').label).toBe('Priya');
  });

  it('names an unknown membership rather than rendering a blank cursor', () => {
    const book = createCursorIdentityBook();
    expect(book.identify('mem_unknown')).toMatchObject({ label: 'Someone' });
  });
});
