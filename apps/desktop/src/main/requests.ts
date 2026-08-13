import {
  joinRequestShape,
  type AcceptResult,
  type ControlClient,
  type CreateRequestInput,
  type JoinRequest,
} from '../core/control-client';
import type { RealtimeClient } from '../core/realtime-client';
import type { Logger } from './logging';

/** Realtime message types for the social loop. */
export const TYPE_REQUEST_INCOMING = 'request.incoming';
export const TYPE_REQUEST_OUTGOING = 'request.outgoing';
export const TYPE_REQUEST_RESOLVED = 'request.resolved';

/** Pending requests as this desktop understands them. */
export interface RequestsState {
  incoming: JoinRequest[];
  outgoing: JoinRequest[];
}

export interface RequestsSupervisorOptions {
  client: ControlClient;
  realtime: RealtimeClient;
  log: Logger;
  onChange?: (state: RequestsState) => void;
  /** Called when accepting a request has put this desktop into a layup. */
  onAccepted?: (result: AcceptResult) => void;
  /** Requests are dropped locally once expired, without waiting for a push. */
  now?: () => number;
}

export interface RequestsSupervisor {
  state(): RequestsState;
  refresh(): Promise<RequestsState>;
  invite(toUserId: string, note?: string): Promise<JoinRequest>;
  /** Invites someone into a layup this desktop is already in. */
  inviteToLayup(toUserId: string, layupId: string): Promise<JoinRequest>;
  /** Knocks on whatever layup a person is in. The layup is never named to us. */
  knock(toUserId: string): Promise<JoinRequest>;
  send(input: CreateRequestInput): Promise<JoinRequest>;
  accept(requestId: string): Promise<void>;
  decline(requestId: string): Promise<void>;
  cancel(requestId: string): Promise<void>;
}

/**
 * Owns the invitations and knocks this desktop knows about.
 *
 * A click never starts media: it creates a request. Media begins only after
 * acceptance produces a membership (SPEC.md §4).
 */
export function createRequestsSupervisor(options: RequestsSupervisorOptions): RequestsSupervisor {
  const { client, realtime, log } = options;
  const now = options.now ?? (() => Date.now());

  let incoming = new Map<string, JoinRequest>();
  let outgoing = new Map<string, JoinRequest>();

  const live = (map: Map<string, JoinRequest>) =>
    [...map.values()]
      .filter((request) => request.state === 'PENDING' && Date.parse(request.expiresAt) > now())
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const snapshot = (): RequestsState => ({ incoming: live(incoming), outgoing: live(outgoing) });

  function publish() {
    options.onChange?.(snapshot());
  }

  function upsert(map: Map<string, JoinRequest>, request: JoinRequest) {
    if (request.state === 'PENDING') map.set(request.id, request);
    else map.delete(request.id);
  }

  const handle = (map: Map<string, JoinRequest>, label: string) => (message: { payload?: unknown }) => {
    try {
      upsert(map, joinRequestShape(message.payload, label));
      publish();
    } catch (error) {
      log.warn('rejected request payload', {
        type: label,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  realtime.on(TYPE_REQUEST_INCOMING, handle(incoming, TYPE_REQUEST_INCOMING));
  realtime.on(TYPE_REQUEST_OUTGOING, handle(outgoing, TYPE_REQUEST_OUTGOING));
  realtime.on(TYPE_REQUEST_RESOLVED, (message) => {
    try {
      const request = joinRequestShape(message.payload, TYPE_REQUEST_RESOLVED);
      incoming.delete(request.id);
      outgoing.delete(request.id);
      log.info('request resolved', { requestId: request.id, state: request.state });
      publish();
    } catch (error) {
      log.warn('rejected resolved request', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return {
    state: snapshot,

    async refresh() {
      const list = await client.listRequests();
      incoming = new Map(list.incoming.map((request) => [request.id, request]));
      outgoing = new Map(list.outgoing.map((request) => [request.id, request]));
      publish();
      return snapshot();
    },

    async send(input) {
      const request = await client.createRequest(input);
      upsert(outgoing, request);
      log.info('request sent', { requestId: request.id, type: request.type, toUserId: request.toUserId });
      publish();
      return request;
    },

    invite(toUserId, note) {
      return this.send({ type: 'INVITE_USER_TO_NEW_LAYUP', toUserId, ...(note ? { note } : {}) });
    },

    inviteToLayup(toUserId, layupId) {
      return this.send({ type: 'INVITE_USER_TO_LAYUP', toUserId, layupId });
    },

    knock(toUserId) {
      return this.send({ type: 'KNOCK_TO_JOIN', toUserId });
    },

    async accept(requestId) {
      const result = await client.acceptRequest(requestId);
      incoming.delete(requestId);
      outgoing.delete(requestId);
      log.info('request accepted', { requestId, layupId: result.layup.id });
      options.onAccepted?.(result);
      publish();
    },

    async decline(requestId) {
      await client.declineRequest(requestId);
      incoming.delete(requestId);
      publish();
    },

    async cancel(requestId) {
      await client.cancelRequest(requestId);
      outgoing.delete(requestId);
      publish();
    },
  };
}
