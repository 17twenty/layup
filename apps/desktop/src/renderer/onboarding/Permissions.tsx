import { useCallback, useEffect, useState } from 'react';
import type { PermissionKind, PermissionState, PermissionsResponse } from '../../shared/ipc';

/**
 * The four things macOS has to agree to, asked for before the call.
 *
 * Two people paired for the first time and spent the call fighting permission
 * prompts. Nothing here is new capability; it is the same four grants, moved
 * from the middle of a conversation to before one.
 *
 * The button is the part that must never lie. Camera and microphone have a
 * real prompt and get "Allow"; screen recording and accessibility do not, and
 * get a deep link to the pane where they are actually granted. An "Allow"
 * button that shows nothing is worse than no button, because it teaches
 * somebody that the application is broken.
 */
type Row = { kind: PermissionKind; label: string; purpose: string };

const ROWS: Row[] = [
  {
    kind: 'camera',
    label: 'Camera',
    purpose: 'So the person you are with can see your face.',
  },
  {
    kind: 'microphone',
    label: 'Microphone',
    purpose: 'So they can hear you.',
  },
  {
    kind: 'screen',
    label: 'Screen Recording',
    purpose: 'So you can share your screen. Layup has to be restarted after this one is ticked.',
  },
  {
    kind: 'accessibility',
    label: 'Accessibility',
    purpose:
      'So somebody you trust can use your mouse and keyboard. Without it their clicks arrive nowhere, and nothing says so.',
  },
];

/** A word for the state, for somebody scanning four rows. */
const STATUS_LABELS: Record<PermissionState['status'], string> = {
  granted: 'Granted',
  denied: 'Blocked',
  restricted: 'Restricted',
  'not-determined': 'Not asked yet',
  'not-required': 'Not needed here',
  unknown: 'Unknown',
};

export interface PermissionsProps {
  /** Leaves the screen. Onboarding is skippable; the footer brings it back. */
  onDone?: () => void;
  /** "Skip for now" on a first run, "Done" on a revisit from the footer. */
  doneLabel?: string;
  /** Every answer this screen gets, so the caller's own marker stays true. */
  onChanged?: (state: PermissionsResponse) => void;
}

export function Permissions({ onDone, doneLabel = 'Skip for now', onChanged }: PermissionsProps = {}) {
  const [state, setState] = useState<PermissionsResponse | undefined>();
  const [busy, setBusy] = useState<PermissionKind | undefined>();

  const refresh = useCallback(async () => {
    try {
      const next = await window.layup.permissions.all();
      setState(next);
      onChanged?.(next);
    } catch {
      // An unanswerable question leaves the rows as they were. Guessing here
      // would put a status on screen that nothing stands behind.
    }
  }, [onChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ask = useCallback(
    async (kind: PermissionKind) => {
      setBusy(kind);
      try {
        await window.layup.permissions.request(kind);
      } catch {
        // Whatever happened, the OS is the source of truth: read it again.
      } finally {
        setBusy(undefined);
      }
      // The prompt is what changes the answer, so the answer is re-read rather
      // than inferred from what the button returned.
      await refresh();
    },
    [refresh],
  );

  return (
    <main className="onboarding">
      <div className="onboarding__card onboarding__card--wide">
        <h1>Before your first call</h1>
        <p className="tagline">
          macOS decides these, not Layup. Granting them now is a minute; discovering them mid-call
          is the call.
        </p>

        <ul className="permissions">
          {ROWS.map(({ kind, label, purpose }) => {
            const entry = state?.[kind];
            return (
              <li key={kind} className="permissions__row" data-testid={`permission-${kind}`}>
                <div className="permissions__what">
                  <span className="permissions__name">{label}</span>
                  <span className="permissions__purpose">{purpose}</span>
                  {entry && !entry.ok && entry.guidance ? (
                    <span className="permissions__guidance">{entry.guidance}</span>
                  ) : null}
                </div>

                <span
                  className={`permissions__status permissions__status--${entry?.status ?? 'unknown'}`}
                  data-testid={`permission-status-${kind}`}
                >
                  {entry ? STATUS_LABELS[entry.status] : 'Checking…'}
                </span>

                {entry && !entry.ok && entry.canRequest ? (
                  <button
                    type="button"
                    className="tile__action"
                    disabled={busy === kind}
                    onClick={() => void ask(kind)}
                    data-testid={`permission-request-${kind}`}
                  >
                    Allow
                  </button>
                ) : entry && !entry.ok && entry.canOpenSettings ? (
                  <button
                    type="button"
                    className="tile__action tile__action--secondary"
                    onClick={() => void window.layup.permissions.openSettings(kind)}
                    data-testid={`permission-settings-${kind}`}
                  >
                    Open Settings
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="permissions__actions">
          <button
            type="button"
            className="onboarding__connect"
            onClick={() => onDone?.()}
            data-testid="permissions-done"
          >
            {doneLabel}
          </button>
          <button
            type="button"
            className="tile__action tile__action--secondary"
            onClick={() => void refresh()}
            data-testid="permissions-recheck"
          >
            Check again
          </button>
        </div>
      </div>
    </main>
  );
}
