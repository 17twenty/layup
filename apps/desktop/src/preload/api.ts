import {
  PROTOCOL_VERSION,
} from '@layup/protocol';
import {
  ipcChannels,
  type ChannelName,
  type ChannelSpec,
  type RequestOf,
  type ResponseOf,
} from '../shared/ipc';

/** How the preload reaches the main process. Injected so it can be tested. */
export type Invoker = (channel: string, payload: unknown) => Promise<unknown>;

/**
 * Builds the object exposed to the renderer as `window.layup`.
 *
 * Every method is enumerated here. There is no generic `invoke`, no channel
 * string passed in from the renderer, and no Node/Electron handle in the
 * returned object (SPEC.md §13.1).
 */
export function createLayupApi(invoker: Invoker) {
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

  return {
    protocolVersion: PROTOCOL_VERSION,
    app: {
      info: () => invoke('app:info', undefined),
    },
    control: {
      /** Current connection state of the Go control plane. */
      status: () => invoke('control:status', undefined),
    },
  } as const;
}

export type LayupApi = ReturnType<typeof createLayupApi>;
