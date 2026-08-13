/**
 * The desktop's view of the organisation's people.
 *
 * Fed by realtime presence events, never by polling. It is a pure reducer over
 * validated payloads so the same logic is used by the main process and by tests.
 */
import { isArrayOf, isEnum, isInteger, isObject, isString, optional, type Envelope } from '@layup/protocol';

export const PERSONAL_PRESENCE = ['AVAILABLE', 'AWAY', 'DND', 'OFFLINE'] as const;
export type PersonalPresence = (typeof PERSONAL_PRESENCE)[number];

export const ACTIVITY_PRESENCE = [
  'NONE',
  'IN_PRIVATE_LAYUP',
  'IN_OPEN_LAYUP',
  'INVITING_YOU',
  'WAITING_FOR_YOU',
] as const;
export type ActivityPresence = (typeof ACTIVITY_PRESENCE)[number];

export const TYPE_PRESENCE_SNAPSHOT = 'presence.snapshot';
export const TYPE_PRESENCE_UPDATE = 'presence.update';

export const personShape = isObject({
  userId: isString,
  displayName: isString,
  statusMessage: optional(isString),
  personal: isEnum(PERSONAL_PRESENCE),
  activity: isEnum(ACTIVITY_PRESENCE),
  layupId: optional(isString),
  layupTitle: optional(isString),
  participantCount: optional(isInteger({ min: 0 })),
});
export type Person = ReturnType<typeof personShape>;

const snapshotShape = isObject({ people: isArrayOf(personShape, { max: 500 }) });
const updateShape = isObject({ person: personShape });

export interface PeopleStore {
  /** Everyone, sorted for display. */
  people(): Person[];
  /** Applies a realtime envelope. Returns true when the list changed. */
  apply(message: Envelope): boolean;
  clear(): void;
}

export function createPeopleStore(): PeopleStore {
  let people = new Map<string, Person>();

  const sorted = () =>
    [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    people: sorted,

    apply(message) {
      if (message.type === TYPE_PRESENCE_SNAPSHOT) {
        const snapshot = snapshotShape(message.payload, TYPE_PRESENCE_SNAPSHOT);
        // A snapshot replaces the world: it is the truth at connect time.
        people = new Map(snapshot.people.map((person) => [person.userId, person]));
        return true;
      }
      if (message.type === TYPE_PRESENCE_UPDATE) {
        const update = updateShape(message.payload, TYPE_PRESENCE_UPDATE);
        const previous = people.get(update.person.userId);
        people.set(update.person.userId, update.person);
        return JSON.stringify(previous) !== JSON.stringify(update.person);
      }
      return false;
    },

    clear() {
      people = new Map();
    },
  };
}
