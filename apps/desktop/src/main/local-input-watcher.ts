/**
 * Notices when the presenter uses their own machine (SPEC.md §13.3).
 *
 * The rule is simple - local input wins - but detecting it honestly is not.
 * Reading global keyboard events would mean watching everything the presenter
 * types, which is exactly what this product must never do. So the signal used
 * here is the one that costs nothing and reveals nothing: the OS pointer moved
 * somewhere this application did not put it.
 *
 * That is deliberately narrow, and it is worth being clear about what it does
 * and does not catch:
 *
 *   - it catches the presenter grabbing their mouse or trackpad, which is what
 *     people actually do when they want control back;
 *   - it does not catch typing alone. The emergency revoke (P1-0513) covers
 *     that case with an explicit shortcut, which is better anyway: a
 *     deliberate action, not an inference drawn from watching keystrokes.
 *
 * Polling only runs while somebody actually holds remote control, so an idle
 * layup costs nothing.
 */
import type { Logger } from './logging';

export interface LocalInputWatcherOptions {
  /** Where the OS pointer is now. */
  cursorPosition: () => { x: number; y: number };
  /** Where remote control last put it, if anywhere. */
  expectedPosition: () => { x: number; y: number } | undefined;
  /** Whether anybody holds remote control right now. */
  remoteActive: () => boolean;
  /** Told when the pointer moved on its own. */
  onLocalInput: () => void;
  log: Logger;
  /** How often to look while remote control is live. */
  intervalMs?: number;
  /**
   * How far the pointer may sit from where we put it before that counts as
   * somebody else moving it. A pixel or two of slack absorbs display scaling.
   */
  tolerancePx?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  cancel?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface LocalInputWatcher {
  /** Checks once, immediately. Returns true when local input was detected. */
  poll(): boolean;
  start(): void;
  stop(): void;
  running(): boolean;
}

export function createLocalInputWatcher(options: LocalInputWatcherOptions): LocalInputWatcher {
  const intervalMs = options.intervalMs ?? 100;
  const tolerance = options.tolerancePx ?? 2;
  const schedule = options.schedule ?? ((callback, delay) => setInterval(callback, delay));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle));

  let timer: ReturnType<typeof setInterval> | undefined;
  let lastSeen: { x: number; y: number } | undefined;

  function poll(): boolean {
    if (!options.remoteActive()) {
      lastSeen = undefined;
      return false;
    }

    const actual = options.cursorPosition();
    const expected = options.expectedPosition();
    const previous = lastSeen;
    lastSeen = actual;

    // Nothing to compare against until remote control has moved the pointer at
    // least once; before that, every position is "unexpected" and would fire
    // constantly.
    if (!expected) return false;
    if (near(actual, expected, tolerance)) return false;
    // It has to have *moved* since the last look. A pointer sitting where the
    // presenter left it is not them using the machine.
    if (previous && near(actual, previous, tolerance)) return false;

    options.log.info('local input takes priority over remote control');
    options.onLocalInput();
    return true;
  }

  return {
    poll,

    start() {
      if (timer) return;
      timer = schedule(() => void poll(), intervalMs);
    },

    stop() {
      if (!timer) return;
      cancel(timer);
      timer = undefined;
      lastSeen = undefined;
    },

    running: () => timer !== undefined,
  };
}

function near(a: { x: number; y: number }, b: { x: number; y: number }, tolerance: number): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}
