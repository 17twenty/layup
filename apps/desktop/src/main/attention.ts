import type { RequestsState } from './requests';
import type { Logger } from './logging';

/**
 * OS-level attention while someone is waiting for you.
 *
 * The rule is "state, not events": the badge reflects how many requests are
 * pending right now. Clicking a person five times changes nothing, because the
 * five clicks collapse into one pending request upstream (SPEC.md §6.5).
 * A wave/nudge feature is explicitly out of scope.
 */
export interface AttentionState {
  /** How many requests are waiting for an answer from this person. */
  pending: number;
  /** Badge text for the dock/taskbar; empty clears it. */
  badge: string;
  /** Tooltip/menu label. */
  label: string;
  /** Whether the window should bounce/flash for attention. */
  shouldAlert: boolean;
}

/** The Electron surfaces this needs, so it can be tested without Electron. */
export interface AttentionSurface {
  setBadge(text: string): void;
  setTooltip(label: string): void;
  /** Requests user attention once, e.g. a dock bounce. */
  alert(): void;
}

export interface AttentionOptions {
  surface: AttentionSurface;
  log?: Logger;
}

export interface AttentionController {
  state(): AttentionState;
  /** Applies the current pending requests. Returns the new state. */
  apply(requests: RequestsState): AttentionState;
}

export function createAttentionController(options: AttentionOptions): AttentionController {
  const { surface } = options;
  let state: AttentionState = { pending: 0, badge: '', label: 'Layup', shouldAlert: false };
  // Which requests we have already alerted for: an alert fires on arrival, not
  // on every state change, so nothing repeats while a request sits pending.
  let alerted = new Set<string>();

  return {
    state: () => state,

    apply(requests) {
      const pendingIds = new Set(requests.incoming.map((request) => request.id));
      const fresh = [...pendingIds].filter((id) => !alerted.has(id));
      // Forget requests that are gone, so a later request with a new id alerts
      // again while a re-sent identical one (same id) does not.
      alerted = new Set([...alerted].filter((id) => pendingIds.has(id)));

      const pending = pendingIds.size;
      const label =
        pending === 0
          ? 'Layup'
          : pending === 1
            ? `${requests.incoming[0]?.fromName ?? 'Someone'} is waiting for you`
            : `${pending} people are waiting for you`;

      state = {
        pending,
        badge: pending === 0 ? '' : String(pending),
        label,
        shouldAlert: fresh.length > 0,
      };

      surface.setBadge(state.badge);
      surface.setTooltip(state.label);
      if (fresh.length > 0) {
        for (const id of fresh) alerted.add(id);
        surface.alert();
        options.log?.info('pending attention raised', { pending, newRequests: fresh.length });
      }
      return state;
    },
  };
}
