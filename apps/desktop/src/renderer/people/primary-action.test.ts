import { describe, expect, it } from 'vitest';
import { presenceLabel, primaryActionFor } from './primary-action';
import type { Person } from '../../core/people-store';

const person = (overrides: Partial<Person> = {}): Person => ({
  userId: 'usr_devkarlx',
  displayName: 'Karl',
  personal: 'AVAILABLE',
  activity: 'NONE',
  ...overrides,
});

describe('primary action rules (SPEC 5.1)', () => {
  it('available -> start layup, at full emphasis', () => {
    expect(primaryActionFor(person())).toMatchObject({
      kind: 'start',
      label: 'Start layup',
      emphasis: 'primary',
      disabled: false,
    });
  });

  it('away -> start layup, lower emphasis', () => {
    expect(primaryActionFor(person({ personal: 'AWAY' }))).toMatchObject({
      kind: 'start',
      emphasis: 'secondary',
      disabled: false,
    });
  });

  it('do-not-disturb -> disabled unless policy allows interrupting', () => {
    expect(primaryActionFor(person({ personal: 'DND' }))).toMatchObject({
      kind: 'none',
      disabled: true,
    });
    expect(primaryActionFor(person({ personal: 'DND' }), { allowInterruptingDND: true })).toMatchObject({
      kind: 'start',
      disabled: false,
    });
  });

  it('in a private layup -> knock', () => {
    expect(primaryActionFor(person({ activity: 'IN_PRIVATE_LAYUP' }))).toMatchObject({
      kind: 'knock',
      label: 'Knock',
      disabled: false,
    });
  });

  it('in an open layup -> join', () => {
    expect(primaryActionFor(person({ activity: 'IN_OPEN_LAYUP' }))).toMatchObject({
      kind: 'join',
      label: 'Join',
    });
  });

  it('inviting you -> respond, and waiting for you -> pending', () => {
    expect(primaryActionFor(person({ activity: 'INVITING_YOU' }))).toMatchObject({ kind: 'respond' });
    expect(primaryActionFor(person({ activity: 'WAITING_FOR_YOU' }))).toMatchObject({ kind: 'pending' });
  });

  it('an invitation outranks personal presence', () => {
    // Even a DND person inviting you must be answerable.
    expect(primaryActionFor(person({ personal: 'DND', activity: 'INVITING_YOU' }))).toMatchObject({
      kind: 'respond',
      disabled: false,
    });
  });

  it('offline -> nothing to do', () => {
    expect(primaryActionFor(person({ personal: 'OFFLINE' }))).toMatchObject({
      kind: 'none',
      disabled: true,
    });
  });
});

describe('presence labels', () => {
  it('describes each state distinctly', () => {
    expect(presenceLabel(person())).toBe('Available');
    expect(presenceLabel(person({ personal: 'AWAY' }))).toBe('Away');
    expect(presenceLabel(person({ personal: 'DND' }))).toBe('Do not disturb');
    expect(presenceLabel(person({ personal: 'OFFLINE' }))).toBe('Offline');
    expect(presenceLabel(person({ activity: 'IN_PRIVATE_LAYUP' }))).toBe('In a layup');
    expect(presenceLabel(person({ activity: 'IN_OPEN_LAYUP', layupTitle: 'Capture path' }))).toBe(
      'In "Capture path"',
    );
    expect(presenceLabel(person({ activity: 'IN_OPEN_LAYUP' }))).toBe('In an open layup');
  });

  it('never names a private layup', () => {
    // A redacted private layup has no title to show, and must not invent one.
    expect(presenceLabel(person({ activity: 'IN_PRIVATE_LAYUP', layupTitle: undefined }))).toBe('In a layup');
  });
  it('does not offer to join the layup you are already in', () => {
    // "Join" next to somebody you are already sitting with reads as though you
    // are not really together.
    const together = primaryActionFor(
      person({ activity: 'IN_OPEN_LAYUP', layupId: 'lay_abc12345' }),
      { currentLayupId: 'lay_abc12345' },
    );
    expect(together).toMatchObject({ kind: 'none', label: 'Here with you', disabled: true });

    // Somebody in a *different* layup is still somewhere to go.
    const elsewhere = primaryActionFor(
      person({ activity: 'IN_OPEN_LAYUP', layupId: 'lay_other1234' }),
      { currentLayupId: 'lay_abc12345' },
    );
    expect(elsewhere).toMatchObject({ kind: 'join', label: 'Join' });
  });
});
