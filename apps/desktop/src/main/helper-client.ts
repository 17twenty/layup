import { createHmac, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { Logger } from './logging';

/**
 * Client for the native input helper (ADR-0006, SPEC.md §13.2).
 *
 * This lives in the **main process only**. It is never exposed on the preload
 * bridge: the renderer has no socket path, no session secret and no channel
 * that forwards an arbitrary command here. Remote input reaches this client
 * through the arbitration in Phase F, never straight from a peer.
 */
export const HELPER_PROTOCOL_VERSION = 1;

export const HELPER_COMMANDS = [
  'helper.hello',
  'helper.capabilities',
  'pointer.move',
  'pointer.button',
  'pointer.wheel',
  'key',
  'input.release_all',
] as const;
export type HelperCommand = (typeof HELPER_COMMANDS)[number];

export interface HelperCapabilities {
  platform: string;
  pointerMove: boolean;
  pointerButton: boolean;
  pointerWheel: boolean;
  keyboard: boolean;
  detail?: string;
}

export interface HelperResponse {
  ok: boolean;
  code?: string;
  error?: string;
  payload?: unknown;
}

export interface HelperClientOptions {
  socketPath: string;
  /** Per-run secret shared with the helper process on its environment. */
  secret: string;
  log: Logger;
  connectImpl?: (path: string) => Socket;
  timeoutMs?: number;
}

export interface HelperClient {
  connect(): Promise<void>;
  send(command: HelperCommand, payload?: unknown): Promise<HelperResponse>;
  capabilities(): Promise<HelperCapabilities | undefined>;
  close(): void;
  connected(): boolean;
}

/** A fresh secret per run: a leaked one is useless after a restart. */
export function newHelperSecret(): string {
  return randomBytes(32).toString('hex');
}

/** The tag the helper verifies. It covers the command, so it cannot be replayed. */
export function signHelperRequest(secret: string, id: string, command: string): string {
  return createHmac('sha256', secret)
    .update(`${HELPER_PROTOCOL_VERSION}\n${id}\n${command}`)
    .digest('hex');
}

export function createHelperClient(options: HelperClientOptions): HelperClient {
  const timeoutMs = options.timeoutMs ?? 2000;
  const pending = new Map<string, (response: HelperResponse) => void>();
  let socket: Socket | undefined;
  let buffer = '';
  let counter = 0;

  function handleLine(line: string) {
    if (!line.trim()) return;
    let message: HelperResponse & { id?: string };
    try {
      message = JSON.parse(line);
    } catch {
      options.log.warn('helper sent unparseable response');
      return;
    }
    const resolve = message.id ? pending.get(message.id) : undefined;
    if (!message.id || !resolve) return;
    pending.delete(message.id);
    resolve(message);
  }

  return {
    connected: () => Boolean(socket && !socket.destroyed),

    connect() {
      return new Promise<void>((resolve, reject) => {
        const impl = options.connectImpl ?? ((path: string) => connect(path));
        const next = impl(options.socketPath);
        socket = next;

        next.setEncoding('utf8');
        next.on('data', (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            handleLine(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
          }
        });
        next.on('error', (error: Error) => {
          options.log.warn('helper socket error', { reason: error.message });
          reject(error);
        });
        next.on('close', () => {
          // Anything still waiting will never be answered.
          for (const [id, waiter] of pending) {
            pending.delete(id);
            waiter({ ok: false, code: 'disconnected', error: 'the input helper went away' });
          }
          socket = undefined;
        });
        next.on('connect', () => resolve());
        if (options.connectImpl) resolve();
      });
    },

    async send(command, payload) {
      if (!socket || socket.destroyed) {
        return { ok: false, code: 'disconnected', error: 'the input helper is not running' };
      }
      const id = String((counter += 1));
      const request = {
        v: HELPER_PROTOCOL_VERSION,
        id,
        command,
        ...(payload === undefined ? {} : { payload }),
        auth: signHelperRequest(options.secret, id, command),
      };

      return new Promise<HelperResponse>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, code: 'timeout', error: `the helper did not answer ${command}` });
        }, timeoutMs);

        pending.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        socket?.write(`${JSON.stringify(request)}\n`);
      });
    },

    async capabilities() {
      const response = await this.send('helper.capabilities');
      if (!response.ok) {
        options.log.warn('could not read helper capabilities', { reason: response.error });
        return undefined;
      }
      return response.payload as HelperCapabilities;
    },

    close() {
      socket?.end();
      socket?.destroy();
      socket = undefined;
    },
  };
}
