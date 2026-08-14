/**
 * Who a cursor belongs to, and what it looks like.
 *
 * Identity is keyed on **membership**, not user: the same person rejoining gets
 * a new membership and therefore a fresh cursor, which is what stops a stale
 * cursor from a previous incarnation lingering or being reused (SPEC.md §3.4).
 */
import type { Participant } from './control-client';

/**
 * A small, deliberately distinguishable palette. Colours are picked to stay
 * apart for the common forms of colour blindness, and are paired with a name
 * label so colour is never the only signal.
 */
export const CURSOR_COLOURS = [
  '#5b8def', // blue
  '#f0805a', // orange
  '#6fd18a', // green
  '#c78bea', // purple
  '#e0b452', // amber
  '#4fc3d9', // teal
] as const;

export interface CursorIdentity {
  membershipId: string;
  label: string;
  colour: string;
}

export interface CursorIdentityBook {
  /** Identity for a membership, allocating a colour on first sight. */
  identify(membershipId: string): CursorIdentity;
  /** Applies the current participant list: assigns names, retires the departed. */
  sync(participants: Participant[]): void;
  /** Memberships whose cursors must be removed. */
  retired(): string[];
  forget(membershipId: string): void;
}

export function createCursorIdentityBook(options: { selfMembershipId?: string } = {}): CursorIdentityBook {
  const identities = new Map<string, CursorIdentity>();
  let retiredIds: string[] = [];

  function allocateColour(): string {
    const used = new Set([...identities.values()].map((identity) => identity.colour));
    // First unused colour keeps two people apart for as long as possible;
    // beyond the palette we wrap, which is fine for a 1:1-first product.
    return CURSOR_COLOURS.find((colour) => !used.has(colour)) ?? CURSOR_COLOURS[identities.size % CURSOR_COLOURS.length]!;
  }

  return {
    identify(membershipId) {
      const existing = identities.get(membershipId);
      if (existing) return existing;
      const identity: CursorIdentity = {
        membershipId,
        label: 'Someone',
        colour: allocateColour(),
      };
      identities.set(membershipId, identity);
      return identity;
    },

    sync(participants) {
      const active = new Set<string>();
      for (const participant of participants) {
        if (participant.leftAt) continue;
        if (participant.membershipId === options.selfMembershipId) continue;
        active.add(participant.membershipId);
        const identity = this.identify(participant.membershipId);
        identity.label = participant.displayName || 'Someone';
      }

      // A membership that is gone takes its cursor with it, promptly. A rejoin
      // arrives as a *different* membership, so it gets a clean identity.
      retiredIds = [...identities.keys()].filter((membershipId) => !active.has(membershipId));
      for (const membershipId of retiredIds) identities.delete(membershipId);
    },

    retired: () => [...retiredIds],
    forget: (membershipId) => void identities.delete(membershipId),
  };
}
