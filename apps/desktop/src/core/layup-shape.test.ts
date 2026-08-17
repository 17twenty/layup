import { describe, expect, it } from 'vitest';
import { layupShape } from './control-client';
import { layupStateResponse } from '../shared/ipc';

/**
 * A layup that somebody is sharing must survive both validators.
 *
 * This is a regression test for a quiet failure: the server has sent
 * `activeShare` since the presenter safety switches landed, and neither shape
 * knew about it. Unknown properties are rejected rather than ignored - which is
 * the right default, and meant that the moment anybody shared their screen,
 * every layup state update was thrown away and leaving the layup failed
 * outright. Nothing said so; the state simply stopped changing.
 */
const sharedLayup = {
  id: 'lay_abc12345',
  organisationId: 'org_devlayup',
  title: 'Pairing',
  visibility: 'ORGANISATION',
  active: true,
  createdAt: '2026-08-14T09:00:00Z',
  hasCreatorAuthority: true,
  creatorMembershipId: 'mem_creator1',
  participants: [
    {
      membershipId: 'mem_creator1',
      userId: 'usr_devnickx',
      displayName: 'Nick',
      joinedAt: '2026-08-14T09:00:00Z',
      isCreatorMembership: true,
    },
  ],
  activeShare: {
    id: 'shr_1',
    presenterMembershipId: 'mem_creator1',
    presenterName: 'Nick',
    sourceId: 'screen:1:0',
    allowDrawing: true,
    allowPointer: false,
    allowKeyboard: false,
  },
};

describe('a layup with somebody sharing', () => {
  it('is accepted by the control-plane shape', () => {
    const parsed = layupShape(sharedLayup, 'layup.state');
    expect(parsed.activeShare?.presenterMembershipId).toBe('mem_creator1');
    expect(parsed.activeShare?.sourceId).toBe('screen:1:0');
  });

  it('crosses the IPC boundary intact', () => {
    const state = layupStateResponse(
      { layup: sharedLayup, membershipId: 'mem_creator1', youAreCreatorMembership: true },
      'layup:changed',
    );
    expect(state.layup?.activeShare?.id).toBe('shr_1');
  });

  it('is equally happy with nobody sharing', () => {
    const { activeShare: _omitted, ...quiet } = sharedLayup;
    expect(() => layupShape(quiet, 'layup.state')).not.toThrow();
    expect(layupShape(quiet, 'layup.state').activeShare).toBeUndefined();
  });

  it('still refuses a property neither side knows', () => {
    // The strictness is deliberate and stays: the fix is teaching the shape
    // about a real field, not opening it to anything.
    expect(() => layupShape({ ...sharedLayup, smuggled: true }, 'layup.state')).toThrow(
      /unexpected property/,
    );
  });
});
