import type { Person } from '../../core/people-store';

/**
 * The primary action on a person tile (SPEC.md §5.1).
 *
 * People are the home screen, so each tile offers exactly one obvious next
 * move. This is a pure function so the rules are testable without a DOM.
 */
export type PrimaryActionKind = 'start' | 'knock' | 'join' | 'respond' | 'pending' | 'none';

export interface PrimaryAction {
  kind: PrimaryActionKind;
  label: string;
  /** Lower emphasis is used when the person is reachable but not present. */
  emphasis: 'primary' | 'secondary';
  disabled: boolean;
  /** Why the action is disabled or de-emphasised, for a tooltip. */
  hint?: string;
}

export interface PrimaryActionPolicy {
  /** Organisation policy may forbid surfacing an action for a DND person. */
  allowInterruptingDND?: boolean;
  /** The layup the viewer is in, so it is not offered to them again. */
  currentLayupId?: string;
}

export function primaryActionFor(person: Person, policy: PrimaryActionPolicy = {}): PrimaryAction {
  // Viewer-relative activity wins: an invitation in flight is the only thing
  // that matters on that tile.
  if (person.activity === 'INVITING_YOU') {
    return { kind: 'respond', label: 'Join', emphasis: 'primary', disabled: false };
  }
  if (person.activity === 'WAITING_FOR_YOU') {
    return {
      kind: 'pending',
      label: 'Waiting…',
      emphasis: 'secondary',
      disabled: false,
      hint: 'They are waiting for you to answer',
    };
  }

  if (person.personal === 'OFFLINE') {
    return {
      kind: 'none',
      label: 'Offline',
      emphasis: 'secondary',
      disabled: true,
      hint: 'This person has no Layup client open',
    };
  }

  if (person.personal === 'DND' && !policy.allowInterruptingDND) {
    return {
      kind: 'none',
      label: 'Do not disturb',
      emphasis: 'secondary',
      disabled: true,
      hint: 'Organisation policy hides actions for people in do-not-disturb',
    };
  }

  // Somebody in the layup you are already in is not somewhere to go: offering
  // "Join" there reads as though you are not really together.
  if (policy.currentLayupId && person.layupId === policy.currentLayupId) {
    return {
      kind: 'none',
      label: 'Here with you',
      emphasis: 'secondary',
      disabled: true,
      hint: 'You are both in this layup',
    };
  }

  if (person.activity === 'IN_OPEN_LAYUP') {
    return { kind: 'join', label: 'Join', emphasis: 'primary', disabled: false };
  }
  if (person.activity === 'IN_PRIVATE_LAYUP') {
    return {
      kind: 'knock',
      label: 'Knock',
      emphasis: 'primary',
      disabled: false,
      hint: 'They are in a private layup',
    };
  }

  // AVAILABLE or AWAY with nothing going on: start something.
  return {
    kind: 'start',
    label: 'Start layup',
    emphasis: person.personal === 'AVAILABLE' ? 'primary' : 'secondary',
    disabled: false,
    ...(person.personal === 'AWAY' ? { hint: 'They are away - they may not answer' } : {}),
  };
}

/** Short human label for the presence pair shown on a tile. */
export function presenceLabel(person: Person): string {
  const personal = {
    AVAILABLE: 'Available',
    AWAY: 'Away',
    DND: 'Do not disturb',
    OFFLINE: 'Offline',
  }[person.personal];

  switch (person.activity) {
    case 'IN_OPEN_LAYUP':
      return person.layupTitle ? `In "${person.layupTitle}"` : 'In an open layup';
    case 'IN_PRIVATE_LAYUP':
      return 'In a layup';
    case 'INVITING_YOU':
      return 'Inviting you';
    case 'WAITING_FOR_YOU':
      return 'Waiting for you';
    default:
      return personal;
  }
}
