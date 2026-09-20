import { describe, expect, it, vi } from 'vitest';
import { envelope } from '@layup/protocol';
import { createRequestsSupervisor, TYPE_REQUEST_INCOMING, TYPE_REQUEST_RESOLVED } from './requests';
import { createLogger } from './logging';
import type { AcceptResult, ControlClient, JoinRequest, Layup } from '../core/control-client';
import type { RealtimeClient } from '../core/realtime-client';

function request(overrides: Partial<JoinRequest> = {}): JoinRequest {
  return {
    id: 'jrq_devaaaaab',
    type: 'INVITE_USER_TO_NEW_LAYUP',
    state: 'PENDING',
    fromUserId: 'usr_devnickx',
    fromName: 'Nick',
    toUserId: 'usr_devkarlx',
    toName: 'Karl',
    createdAt: '2026-08-13T09:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    ...overrides,
  };
}

function layup(overrides: Partial<Layup> = {}): Layup {
  return {
    id: 'lay_abc12345',
    organisationId: 'org_devlayup',
    visibility: 'ORGANISATION',
    active: true,
    createdAt: '2026-08-13T09:00:00Z',
    hasCreatorAuthority: false,
    participants: [
      {
        membershipId: 'mem_join1',
        userId: 'usr_devkarlx',
        displayName: 'Karl',
        joinedAt: '2026-08-13T09:01:00Z',
        isCreatorMembership: false,
        isGuest: false,
      },
    ],
    ...overrides,
  };
}

function harness(options: { onAccepted?: (result: AcceptResult) => void } = {}) {
  const handlers = new Map<string, (message: ReturnType<typeof envelope>) => void>();
  const realtime = {
    on: vi.fn((type: string, handler: (message: ReturnType<typeof envelope>) => void) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    }),
  } as unknown as RealtimeClient;

  const client = {
    listRequests: vi.fn(async () => ({ incoming: [], outgoing: [] })),
    acceptRequest: vi.fn(),
    declineRequest: vi.fn(async () => request()),
    cancelRequest: vi.fn(async () => request()),
    createRequest: vi.fn(async () => request()),
  } as unknown as ControlClient;

  const lines: Array<{ level: string; msg: string; [key: string]: unknown }> = [];
  const log = createLogger({
    level: 'debug',
    write: (line) => lines.push(JSON.parse(line) as { level: string; msg: string }),
  });

  const changes: unknown[] = [];
  const supervisor = createRequestsSupervisor({
    client,
    realtime,
    log,
    onChange: (state) => changes.push(state),
    ...(options.onAccepted ? { onAccepted: options.onAccepted } : {}),
  });

  return {
    supervisor,
    client,
    changes,
    lines,
    push: (type: string, payload: unknown) => handlers.get(type)?.(envelope(type, payload)),
  };
}

describe('requests supervisor: instrumentation', () => {
  it('logs a received invitation without the note or any token-shaped field', () => {
    const h = harness();
    h.push(TYPE_REQUEST_INCOMING, request({ note: 'Auth is doing something dumb' }));

    const received = h.lines.find((line) => line.msg === 'request received');
    expect(received).toMatchObject({
      requestId: 'jrq_devaaaaab',
      requestType: 'INVITE_USER_TO_NEW_LAYUP',
      fromUserId: 'usr_devnickx',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    expect(JSON.stringify(received)).not.toContain('Auth is doing something dumb');
    expect(JSON.stringify(h.lines)).not.toMatch(/token/i);
  });

  it('logs an accept attempt, its result, and the join that follows', async () => {
    const result: AcceptResult = { request: request(), layup: layup(), yourMembershipId: 'mem_join1' };
    const h = harness({ onAccepted: vi.fn() });
    (h.client.acceptRequest as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    await h.supervisor.accept('jrq_devaaaaab');

    expect(h.lines.map((l) => l.msg)).toEqual([
      'accept attempted',
      'request accepted',
      'layup join after accept',
    ]);
    const joinLine = h.lines.find((l) => l.msg === 'layup join after accept');
    expect(joinLine).toMatchObject({ requestId: 'jrq_devaaaaab', layupId: 'lay_abc12345', outcome: 'ok' });
  });

  it('logs why an accept failed, and never swallows the rejection', async () => {
    const h = harness();
    (h.client.acceptRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP 409: request expired'));

    await expect(h.supervisor.accept('jrq_devaaaaab')).rejects.toThrow('HTTP 409');

    const failure = h.lines.find((l) => l.msg === 'accept failed');
    expect(failure).toMatchObject({ requestId: 'jrq_devaaaaab', reason: 'HTTP 409: request expired' });
    // No success line was ever produced for this request.
    expect(h.lines.some((l) => l.msg === 'request accepted')).toBe(false);
  });

  it('logs when the join that follows a successful accept itself throws', async () => {
    const result: AcceptResult = { request: request(), layup: layup(), yourMembershipId: 'mem_join1' };
    const onAccepted = vi.fn(() => {
      throw new Error('could not adopt the layup locally');
    });
    const h = harness({ onAccepted });
    (h.client.acceptRequest as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    await expect(h.supervisor.accept('jrq_devaaaaab')).rejects.toThrow('could not adopt');

    const failure = h.lines.find((l) => l.msg === 'layup join after accept failed');
    expect(failure).toMatchObject({
      requestId: 'jrq_devaaaaab',
      layupId: 'lay_abc12345',
      outcome: 'failed',
      reason: 'could not adopt the layup locally',
    });
  });
});

describe('requests supervisor: accepting while already in another layup', () => {
  it('accept succeeds the same way regardless of whether this desktop is already in a layup', async () => {
    // The supervisor itself has no notion of "already in a layup" - that
    // check lives in the renderer (busyElsewhere) and decides only which
    // button is shown. Accept always just accepts; this pins that down so a
    // future change cannot quietly make it conditional.
    const result: AcceptResult = { request: request(), layup: layup(), yourMembershipId: 'mem_join1' };
    const onAccepted = vi.fn();
    const h = harness({ onAccepted });
    (h.client.acceptRequest as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    const state = await h.supervisor.accept('jrq_devaaaaab');

    expect(state).toBeUndefined();
    expect(onAccepted).toHaveBeenCalledWith(result);
    expect(h.client.acceptRequest).toHaveBeenCalledWith('jrq_devaaaaab');
  });
});

describe('requests supervisor: expiry', () => {
  it('drops a request from the live snapshot once its own clock runs out, without waiting for a push', async () => {
    let now = Date.parse('2026-08-13T09:00:00Z');
    const handlers = new Map<string, (message: ReturnType<typeof envelope>) => void>();
    const realtime = {
      on: vi.fn((type: string, handler: (message: ReturnType<typeof envelope>) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      }),
    } as unknown as RealtimeClient;
    const client = {
      listRequests: vi.fn(async () => ({
        incoming: [request({ expiresAt: '2026-08-13T09:00:30Z' })],
        outgoing: [],
      })),
    } as unknown as ControlClient;

    const supervisor = createRequestsSupervisor({
      client,
      realtime,
      log: createLogger({ level: 'error', write: () => {} }),
      now: () => now,
    });

    const initial = await supervisor.refresh();
    expect(initial.incoming).toHaveLength(1);

    now = Date.parse('2026-08-13T09:00:31Z');
    expect(supervisor.state().incoming).toHaveLength(0);
  });
});

describe('requests supervisor: decline and cancel', () => {
  it('logs a decline failure and leaves the request in place for the retry', async () => {
    const h = harness();
    h.push(TYPE_REQUEST_INCOMING, request());
    (h.client.declineRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));

    await expect(h.supervisor.decline('jrq_devaaaaab')).rejects.toThrow('offline');

    expect(h.supervisor.state().incoming).toHaveLength(1);
    const failure = h.lines.find((l) => l.msg === 'decline failed');
    expect(failure).toMatchObject({ requestId: 'jrq_devaaaaab', reason: 'offline' });
  });

  it('removes a resolved request pushed from the server', () => {
    const h = harness();
    h.push(TYPE_REQUEST_INCOMING, request());
    expect(h.supervisor.state().incoming).toHaveLength(1);

    h.push(TYPE_REQUEST_RESOLVED, request({ state: 'ACCEPTED' }));
    expect(h.supervisor.state().incoming).toHaveLength(0);
  });
});
