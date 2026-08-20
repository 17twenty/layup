import { describe, expect, it, vi } from 'vitest';
import { envelope } from '@layup/protocol';
import { createLayupSupervisor, TYPE_LAYUP_STATE } from './layups';
import { createLogger } from './logging';
import type { ControlClient, Layup, MembershipResult } from '../core/control-client';
import type { RealtimeClient } from '../core/realtime-client';

function layup(overrides: Partial<Layup> = {}): Layup {
  return {
    id: 'lay_abc12345',
    organisationId: 'org_devlayup',
    title: 'Capture path',
    visibility: 'ORGANISATION',
    active: true,
    createdAt: '2026-08-13T09:00:00Z',
    hasCreatorAuthority: true,
    creatorMembershipId: 'mem_creator1',
    participants: [
      {
        membershipId: 'mem_creator1',
        userId: 'usr_devnickx',
        displayName: 'Nick',
        joinedAt: '2026-08-13T09:00:00Z',
        isCreatorMembership: true,
        isGuest: false,
      },
    ],
    ...overrides,
  };
}

function harness(result: MembershipResult) {
  const handlers = new Map<string, (message: ReturnType<typeof envelope>) => void>();
  const realtime = {
    on: vi.fn((type: string, handler: (message: ReturnType<typeof envelope>) => void) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    }),
  } as unknown as RealtimeClient;

  const client = {
    createLayup: vi.fn(async () => result),
    joinLayup: vi.fn(async () => result),
    leaveLayup: vi.fn(async () => ({
      layup: { ...result.layup, participants: [] },
      yourMembershipId: result.yourMembershipId,
    })),
  } as unknown as ControlClient;

  const changes: unknown[] = [];
  const supervisor = createLayupSupervisor({
    client,
    realtime,
    log: createLogger({ level: 'error', write: () => {} }),
    onChange: (state) => changes.push(state),
  });

  return {
    supervisor,
    client,
    changes,
    push: (payload: unknown) => handlers.get(TYPE_LAYUP_STATE)?.(envelope(TYPE_LAYUP_STATE, payload)),
  };
}

describe('layup supervisor', () => {
  it('creates a layup and knows it is the creator membership', async () => {
    const h = harness({ layup: layup(), yourMembershipId: 'mem_creator1' });
    const state = await h.supervisor.create({ title: 'Capture path' });

    expect(state.layup?.id).toBe('lay_abc12345');
    expect(state.membershipId).toBe('mem_creator1');
    expect(state.youAreCreatorMembership).toBe(true);
    expect(h.changes).toHaveLength(1);
  });

  it('joins as an ordinary membership', async () => {
    const joined = layup({
      participants: [
        ...layup().participants,
        {
          membershipId: 'mem_join1',
          userId: 'usr_devkarlx',
          displayName: 'Karl',
          joinedAt: '2026-08-13T09:01:00Z',
          isCreatorMembership: false,
          isGuest: false,
        },
      ],
    });
    const h = harness({ layup: joined, yourMembershipId: 'mem_join1' });
    const state = await h.supervisor.join('lay_abc12345');

    expect(state.membershipId).toBe('mem_join1');
    expect(state.youAreCreatorMembership).toBe(false);
    expect(state.layup?.participants).toHaveLength(2);
  });

  it('applies realtime membership updates for the layup it is in', async () => {
    const h = harness({ layup: layup(), yourMembershipId: 'mem_creator1' });
    await h.supervisor.create();

    h.push({
      ...layup(),
      participants: [
        ...layup().participants,
        {
          membershipId: 'mem_join1',
          userId: 'usr_devkarlx',
          displayName: 'Karl',
          joinedAt: '2026-08-13T09:01:00Z',
          isCreatorMembership: false,
          isGuest: false,
        },
      ],
    });

    expect(h.supervisor.state().layup?.participants).toHaveLength(2);
  });

  it('drops creator authority the moment the server says it is gone', async () => {
    const h = harness({ layup: layup(), yourMembershipId: 'mem_creator1' });
    await h.supervisor.create();
    expect(h.supervisor.state().youAreCreatorMembership).toBe(true);

    // Server state after the creator membership ended and rejoined as ordinary.
    h.push({
      ...layup(),
      hasCreatorAuthority: false,
      creatorMembershipId: undefined,
      participants: [
        {
          membershipId: 'mem_creator1',
          userId: 'usr_devnickx',
          displayName: 'Nick',
          joinedAt: '2026-08-13T09:00:00Z',
          isCreatorMembership: false,
          isGuest: false,
        },
      ],
    });

    expect(h.supervisor.state().youAreCreatorMembership).toBe(false);
  });

  it('clears state when the layup ends', async () => {
    const h = harness({ layup: layup(), yourMembershipId: 'mem_creator1' });
    await h.supervisor.create();

    h.push({ ...layup(), active: false, endedAt: '2026-08-13T09:05:00Z' });
    expect(h.supervisor.state().layup).toBeUndefined();
  });

  it('ignores state for a different layup', async () => {
    const h = harness({ layup: layup(), yourMembershipId: 'mem_creator1' });
    await h.supervisor.create();

    h.push({ ...layup(), id: 'lay_other123', title: 'Someone else' });
    expect(h.supervisor.state().layup?.title).toBe('Capture path');
  });

  it('rejects malformed layup state', async () => {
    const h = harness({ layup: layup(), yourMembershipId: 'mem_creator1' });
    await h.supervisor.create();

    h.push({ id: 'lay_abc12345' });
    expect(h.supervisor.state().layup?.participants).toHaveLength(1);
  });

  it('leaving clears local state', async () => {
    const h = harness({ layup: layup(), yourMembershipId: 'mem_creator1' });
    await h.supervisor.create();

    const state = await h.supervisor.leave();
    expect(state.layup).toBeUndefined();
    expect(state.youAreCreatorMembership).toBe(false);
  });
});
