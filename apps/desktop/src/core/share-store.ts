/**
 * What is being shared, and what just happened to it (SPEC.md §7.1, §7.2).
 *
 * Exactly one shared desktop exists per layup, so this holds one share or none.
 * "None" is a normal state, not an error: a layup with nobody sharing is still
 * a perfectly good place to talk.
 *
 * The other half of this is the **notice**. Taking the screen in a
 * collaborative layup needs no approval, which only works if the person who
 * lost it finds out at once - otherwise they carry on talking over a screen
 * nobody can see. So a takeover produces a plain sentence, and so does somebody
 * asking for an advertised session's screen. Both expire on their own; a notice
 * that has to be dismissed is a dialog wearing a disguise.
 */
import type { ScreenShare } from './control-client';

export const TYPE_SCREEN_STARTED = 'screen.started';
export const TYPE_SCREEN_STOPPED = 'screen.stopped';
export const TYPE_SCREEN_SETTINGS = 'screen.settings';
export const TYPE_SCREEN_TAKEOVER = 'screen.takeover';
export const TYPE_SCREEN_SHARE_REQUEST = 'screen.share_request';

export interface ShareNotice {
  kind: 'takeover' | 'ask-to-share';
  /** One sentence, already written for a person to read. */
  text: string;
  /** Who is asking, when somebody is. */
  membershipId?: string;
  atMs: number;
}

export interface ShareState {
  share?: ScreenShare;
  notice?: ShareNotice;
}

export interface ShareStoreOptions {
  /** This desktop's membership, to know whether a share is ours. */
  membershipId?: () => string | undefined;
  /** How long a notice stays on screen. */
  noticeMs?: number;
  now?: () => number;
}

export interface ShareStore {
  state(): ShareState;
  /** True when this desktop is the one presenting. */
  isPresenting(): boolean;
  /** Applies one control-plane event. Returns true when the state changed. */
  apply(type: string, payload: unknown): boolean;
  /** Drops a notice that has outlived its welcome. */
  sweep(): boolean;
  subscribe(listener: (state: ShareState) => void): () => void;
}

export function createShareStore(options: ShareStoreOptions = {}): ShareStore {
  const now = options.now ?? (() => Date.now());
  const noticeMs = options.noticeMs ?? 8_000;
  const listeners = new Set<(state: ShareState) => void>();
  let state: ShareState = {};

  function set(next: ShareState): boolean {
    state = next;
    for (const listener of listeners) listener(state);
    return true;
  }

  return {
    state: () => state,

    isPresenting() {
      const mine = options.membershipId?.();
      return Boolean(mine && state.share && state.share.presenterMembershipId === mine);
    },

    apply(type, payload) {
      const data = (payload ?? {}) as Record<string, unknown>;

      switch (type) {
        case TYPE_SCREEN_STARTED:
        case TYPE_SCREEN_SETTINGS: {
          const share = payload as ScreenShare;
          if (!share?.id) return false;
          return set({ ...state, share });
        }

        case TYPE_SCREEN_STOPPED:
          if (!state.share) return false;
          // Losing the share is not losing the layup.
          return set({ ...state, share: undefined });

        case TYPE_SCREEN_TAKEOVER: {
          // Our own share was replaced. The server tells the person who lost
          // it, so this only ever arrives on their machine.
          const takenByName = typeof data.takenByName === 'string' ? data.takenByName : 'Someone';
          return set({
            share: undefined,
            notice: {
              kind: 'takeover',
              text: `${takenByName} is sharing their screen now.`,
              atMs: now(),
            },
          });
        }

        case TYPE_SCREEN_SHARE_REQUEST: {
          const askedByName = typeof data.askedByName === 'string' ? data.askedByName : 'Someone';
          const membershipId =
            typeof data.askedByMembershipId === 'string' ? data.askedByMembershipId : undefined;
          return set({
            ...state,
            notice: {
              kind: 'ask-to-share',
              text: `${askedByName} would like to share their screen.`,
              ...(membershipId ? { membershipId } : {}),
              atMs: now(),
            },
          });
        }

        default:
          return false;
      }
    },

    sweep() {
      if (!state.notice) return false;
      if (now() - state.notice.atMs < noticeMs) return false;
      // Notices fade on their own: one that has to be dismissed is a dialog
      // wearing a disguise.
      return set({ ...state, notice: undefined });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
