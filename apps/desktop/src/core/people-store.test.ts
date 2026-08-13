import { describe, expect, it } from 'vitest';
import { ValidationError, envelope } from '@layup/protocol';
import { createPeopleStore, type Person } from './people-store';

const karl: Person = {
  userId: 'usr_devkarlx',
  displayName: 'Karl',
  personal: 'AVAILABLE',
  activity: 'NONE',
};
const nick: Person = {
  userId: 'usr_devnickx',
  displayName: 'Nick',
  personal: 'AWAY',
  activity: 'NONE',
};

describe('people store', () => {
  it('replaces everything on a snapshot and sorts for display', () => {
    const store = createPeopleStore();
    expect(store.apply(envelope('presence.snapshot', { people: [karl, nick] }))).toBe(true);
    expect(store.people().map((p) => p.displayName)).toEqual(['Karl', 'Nick']);

    store.apply(envelope('presence.snapshot', { people: [nick] }));
    expect(store.people().map((p) => p.displayName)).toEqual(['Nick']);
  });

  it('applies a single update without touching anyone else', () => {
    const store = createPeopleStore();
    store.apply(envelope('presence.snapshot', { people: [karl, nick] }));

    const changed = store.apply(
      envelope('presence.update', {
        person: { ...karl, personal: 'DND', activity: 'IN_PRIVATE_LAYUP' },
      }),
    );

    expect(changed).toBe(true);
    expect(store.people().find((p) => p.userId === karl.userId)).toMatchObject({
      personal: 'DND',
      activity: 'IN_PRIVATE_LAYUP',
    });
    expect(store.people().find((p) => p.userId === nick.userId)).toMatchObject({ personal: 'AWAY' });
  });

  it('reports no change when an update repeats current state', () => {
    const store = createPeopleStore();
    store.apply(envelope('presence.snapshot', { people: [karl] }));
    expect(store.apply(envelope('presence.update', { person: karl }))).toBe(false);
  });

  it('keeps open-layup detail and tolerates redacted private state', () => {
    const store = createPeopleStore();
    store.apply(
      envelope('presence.snapshot', {
        people: [
          { ...karl, activity: 'IN_OPEN_LAYUP', layupId: 'lay_abc12345', layupTitle: 'Capture path', participantCount: 3 },
          { ...nick, activity: 'IN_PRIVATE_LAYUP' },
        ],
      }),
    );

    const [k, n] = store.people();
    expect(n).toBeDefined();
    expect(k).toMatchObject({ layupId: 'lay_abc12345', layupTitle: 'Capture path', participantCount: 3 });
    expect(n?.layupId).toBeUndefined();
    expect(n?.layupTitle).toBeUndefined();
  });

  it('rejects malformed presence payloads', () => {
    const store = createPeopleStore();
    expect(() => store.apply(envelope('presence.snapshot', { people: [{ userId: 'x' }] }))).toThrow(
      ValidationError,
    );
    expect(() =>
      store.apply(envelope('presence.update', { person: { ...karl, personal: 'PARTYING' } })),
    ).toThrow(ValidationError);
    expect(store.people()).toEqual([]);
  });

  it('ignores unrelated messages', () => {
    const store = createPeopleStore();
    expect(store.apply(envelope('heartbeat', { seq: 1 }))).toBe(false);
  });
});
