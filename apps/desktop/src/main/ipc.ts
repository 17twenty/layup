import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  channelNames,
  ipcChannels,
  type ChannelName,
  type RequestOf,
  type ResponseOf,
} from '../shared/ipc';
import { ValidationError } from '../shared/validate';

/**
 * Privileged side of the IPC boundary.
 *
 * Every handler is wrapped so that:
 *   - the request payload is validated before the handler runs;
 *   - the response is validated before it is handed back to the renderer;
 *   - a rejected payload is a logged, non-fatal error - never a partial action.
 */

export type Handler<C extends ChannelName> = (
  request: RequestOf<C>,
  event: IpcMainInvokeEvent,
) => ResponseOf<C> | Promise<ResponseOf<C>>;

export type Handlers = { [C in ChannelName]: Handler<C> };

export interface IpcRegistrationOptions {
  onRejected?: (channel: ChannelName, error: ValidationError) => void;
}

/** Minimal subset of ipcMain we need, so this is testable without Electron. */
export interface HandleTarget {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
}

export function registerIpcHandlers(
  ipcMain: HandleTarget | IpcMain,
  handlers: Handlers,
  options: IpcRegistrationOptions = {},
): void {
  for (const name of channelNames) {
    const spec = ipcChannels[name];
    const handler = handlers[name] as Handler<ChannelName>;

    (ipcMain as HandleTarget).handle(name, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length > 1) {
        const error = new ValidationError(name, 'expected at most one payload argument');
        options.onRejected?.(name, error);
        throw error;
      }
      let request: RequestOf<ChannelName>;
      try {
        request = spec.request(args[0], name) as RequestOf<ChannelName>;
      } catch (cause) {
        const error =
          cause instanceof ValidationError ? cause : new ValidationError(name, 'invalid request');
        options.onRejected?.(name, error);
        throw error;
      }

      const result = await handler(request, event);
      // Validating our own response keeps a handler bug from leaking a shape
      // the renderer was never promised.
      return spec.response(result, `${name}.response`);
    });
  }
}
