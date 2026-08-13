import { PROTOCOL_VERSION } from '@layup/protocol';
import {
  ipcChannels,
  ipcEvents,
  type ChannelName,
  type ChannelSpec,
  type EventName,
  type EventPayload,
  type RequestOf,
  type ResponseOf,
} from '../shared/ipc';

/** How the preload reaches the main process. Injected so it can be tested. */
export type Invoker = (channel: string, payload: unknown) => Promise<unknown>;

/** How the preload receives pushes from the main process. */
export type Subscriber = (channel: string, listener: (payload: unknown) => void) => () => void;

/**
 * Builds the object exposed to the renderer as `window.layup`.
 *
 * Every method is enumerated here. There is no generic `invoke`, no channel
 * string passed in from the renderer, and no Node/Electron handle in the
 * returned object (SPEC.md §13.1).
 */
export function createLayupApi(invoker: Invoker, subscriber: Subscriber = () => () => {}) {
  async function invoke<C extends ChannelName>(
    channel: C,
    request: RequestOf<C>,
  ): Promise<ResponseOf<C>> {
    const spec = ipcChannels[channel] as ChannelSpec<RequestOf<C>, ResponseOf<C>>;
    // Validate on the way out as well: a renderer bug should fail here, loudly,
    // rather than become an unchecked payload in the privileged process.
    const validatedRequest = spec.request(request, channel);
    const raw = await invoker(channel, validatedRequest);
    return spec.response(raw, `${channel}.response`);
  }

  /** Subscribes to a push event, validating every payload before delivery. */
  function subscribe<E extends EventName>(
    event: E,
    handler: (payload: EventPayload<E>) => void,
  ): () => void {
    const validate = ipcEvents[event];
    return subscriber(event, (raw) => {
      let payload: EventPayload<E>;
      try {
        payload = validate(raw, event) as EventPayload<E>;
      } catch {
        // A malformed push is dropped, never handed to the UI.
        return;
      }
      handler(payload);
    });
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    app: {
      info: () => invoke('app:info', undefined),
    },
    control: {
      /** Current connection state of the Go control plane. */
      status: () => invoke('control:status', undefined),
    },
    identity: {
      /** Who this desktop is running as (PLAN-1 development identity). */
      current: () => invoke('identity:current', undefined),
    },
    people: {
      /** Everyone in the organisation with their presence. */
      list: () => invoke('people:list', undefined),
      /** Subscribe to people/presence changes. Returns unsubscribe. */
      onChanged: (handler: (payload: EventPayload<'people:changed'>) => void) =>
        subscribe('people:changed', handler),
    },
    layup: {
      /** The layup this desktop is in, if any. */
      current: () => invoke('layup:current', undefined),
      /** Creates a layup with you as the creator membership. */
      create: (input: { title?: string; visibility?: 'PRIVATE' | 'ORGANISATION' | 'LINK' } = {}) =>
        invoke('layup:create', input),
      /** Joins an existing layup. */
      join: (layupId: string) => invoke('layup:join', { layupId }),
      /** Ends your own membership. Nobody can remove anyone else. */
      leave: () => invoke('layup:leave', undefined),
      /** Subscribe to layup state changes. Returns unsubscribe. */
      onChanged: (handler: (state: EventPayload<'layup:changed'>) => void) =>
        subscribe('layup:changed', handler),
    },
    realtime: {
      /** Current realtime connection state. */
      status: () => invoke('realtime:status', undefined),
      /** Subscribe to realtime connection-state changes. Returns unsubscribe. */
      onState: (handler: (state: EventPayload<'realtime:state'>) => void) =>
        subscribe('realtime:state', handler),
    },
  } as const;
}

export type LayupApi = ReturnType<typeof createLayupApi>;
