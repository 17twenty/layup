import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHelperClient,
  newHelperSecret,
  type HelperCapabilities,
  type HelperClient,
} from './helper-client';
import type { Logger } from './logging';

/**
 * Owns the native input helper's lifetime (ADR-0006).
 *
 * One helper per desktop, started lazily, exiting with us. A crash is detected
 * and restarted with a **fresh secret and socket**, so a leaked secret from the
 * dead process is worthless.
 */
export interface HelperState {
  running: boolean;
  /** What this helper build can actually do, once it has told us. */
  capabilities?: HelperCapabilities;
  /** Why remote control is unavailable, in words a person can act on. */
  detail?: string;
  restarts: number;
}

export interface HelperSupervisorOptions {
  /** Path to the helper binary. */
  binaryPath: string;
  log: Logger;
  spawnImpl?: (path: string, env: NodeJS.ProcessEnv) => ChildProcess;
  createClient?: (socketPath: string, secret: string) => HelperClient;
  /** Restarts closer together than this are treated as a crash loop. */
  restartBackoffMs?: number;
  maxRestarts?: number;
  onState?: (state: HelperState) => void;
}

export interface HelperSupervisor {
  start(): Promise<HelperState>;
  state(): HelperState;
  client(): HelperClient | undefined;
  stop(): void;
}

export function createHelperSupervisor(options: HelperSupervisorOptions): HelperSupervisor {
  const maxRestarts = options.maxRestarts ?? 3;
  let state: HelperState = { running: false, restarts: 0 };
  let child: ChildProcess | undefined;
  let helper: HelperClient | undefined;
  let stopped = false;

  const publish = () => {
    options.onState?.(state);
    return state;
  };

  async function launch(): Promise<HelperState> {
    // Fresh per run: a secret that leaked from a previous process is useless,
    // and a stale socket cannot be hijacked.
    const secret = newHelperSecret();
    const socketPath = join(mkdtempSync(join(tmpdir(), 'layup-helper-')), 'helper.sock');

    const spawnImpl =
      options.spawnImpl ??
      ((path: string, env: NodeJS.ProcessEnv) => spawn(path, [], { env, stdio: ['ignore', 'ignore', 'pipe'] }));

    child = spawnImpl(options.binaryPath, {
      ...process.env,
      LAYUP_HELPER_SECRET: secret,
      LAYUP_HELPER_SOCKET: socketPath,
    });

    child.on('exit', (code) => {
      helper?.close();
      helper = undefined;
      state = { ...state, running: false, detail: `the input helper exited (${code ?? 'signal'})` };
      publish();
      if (stopped) return;

      if (state.restarts >= maxRestarts) {
        // A crash loop is reported, not hidden behind endless restarts.
        state = {
          ...state,
          detail: 'the input helper keeps crashing; remote control is unavailable',
        };
        options.log.warn('input helper crash loop; giving up', { restarts: state.restarts });
        publish();
        return;
      }
      state = { ...state, restarts: state.restarts + 1 };
      options.log.warn('input helper exited; restarting', { restarts: state.restarts });
      setTimeout(() => void launch(), options.restartBackoffMs ?? 500);
    });

    helper =
      options.createClient?.(socketPath, secret) ??
      createHelperClient({ socketPath, secret, log: options.log });

    // The socket appears a moment after the process does.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await helper.connect();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const capabilities = await helper.capabilities();
    state = {
      running: helper.connected(),
      restarts: state.restarts,
      ...(capabilities ? { capabilities } : {}),
      ...(capabilities?.detail ? { detail: capabilities.detail } : {}),
    };
    options.log.info('input helper ready', {
      running: state.running,
      platform: capabilities?.platform,
      // Capability flags only - never the secret, never a socket path.
      keyboard: capabilities?.keyboard,
      pointer: capabilities?.pointerMove,
    });
    return publish();
  }

  return {
    start() {
      stopped = false;
      return launch();
    },
    state: () => state,
    client: () => helper,
    stop() {
      stopped = true;
      helper?.close();
      helper = undefined;
      child?.kill('SIGTERM');
      child = undefined;
      state = { ...state, running: false };
      publish();
    },
  };
}
