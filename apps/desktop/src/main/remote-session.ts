/**
 * The privileged half of a layup: who is sharing, who may act on this machine,
 * and the only path from a peer's message to an OS event.
 *
 * The split matters more than the code. The renderer owns *transport* - it has
 * the peer connections and the data channels, because that is where Chromium
 * is - and this owns *authority*. A message a peer sent arrives here through
 * one narrow channel and is judged by the guard against state the renderer
 * cannot reach: the presenter's switches, the grants, the leases (ADR-0006).
 *
 * Everything is rebuilt when the membership changes. Grants belong to a share
 * in a layup, so leaving one must not leave anything behind that could apply to
 * the next.
 */
import { createInputGuard, type InputGuard } from '../core/input-guard';
import { createRemoteControl, type RemoteControl } from '../core/remote-control';
import {
  createShareStore,
  TYPE_SCREEN_SETTINGS,
  TYPE_SCREEN_SHARE_REQUEST,
  TYPE_SCREEN_STARTED,
  TYPE_SCREEN_STOPPED,
  TYPE_SCREEN_TAKEOVER,
  type ShareStore,
} from '../core/share-store';
import type { ControlMessage, ControlScope } from '@layup/protocol';
import { CHANNEL_INPUT } from '../core/data-channels';
import type { ControlClient } from '../core/control-client';
import type { RemoteControlStateResponse, ShareStateResponse } from '../shared/ipc';
import { createRemoteInputRouter, type RemoteInputRouter } from './remote-input';
import { createEmergencyRevoke, EMERGENCY_REVOKE_SHORTCUT, type EmergencyRevoke } from './emergency-revoke';
import type { HelperSupervisor } from './helper-supervisor';
import type { DisplayBounds } from '../core/pointer-mapping';
import type { Logger } from './logging';

/**
 * As much of a participant as this module reads. Deliberately structural
 * rather than `control-client`'s `Participant`: authority here turns on one
 * server-set flag, and narrowing to it says so.
 */
export interface RosterParticipant {
  membershipId: string;
  /** Set by the server (`ParticipantDTO.isGuest`); absent means "not a guest". */
  isGuest?: boolean;
}

/** The realtime event types this listens to, all screen-share lifecycle. */
export const SHARE_EVENT_TYPES = [
  TYPE_SCREEN_STARTED,
  TYPE_SCREEN_STOPPED,
  TYPE_SCREEN_SETTINGS,
  TYPE_SCREEN_TAKEOVER,
  TYPE_SCREEN_SHARE_REQUEST,
] as const;

export interface RemoteSessionOptions {
  client: ControlClient;
  helper: HelperSupervisor;
  /** The presenter's displays, in the OS's own coordinate space. */
  displays: () => DisplayBounds[];
  log: Logger;
  /** Pushes a state change to the windows. */
  onShareChanged: (state: ShareStateResponse) => void;
  onControlChanged: (state: RemoteControlStateResponse) => void;
  /** Asks the renderer to put a control decision on the wire. */
  sendToPeers: (message: ControlMessage) => void;
  /** Registers the emergency accelerator with the OS. */
  registerShortcut?: (accelerator: string, handler: () => void) => boolean;
  unregisterShortcut?: (accelerator: string) => void;
}

export interface RemoteSession {
  /** Rebuilds for a new membership, or tears down when there is none. */
  setMembership(membershipId: string | undefined, layupId: string | undefined): void;
  /**
   * Takes the layup's roster as the control plane describes it, and keeps the
   * set of guest memberships from it.
   *
   * This is the *only* way the guard can learn that a membership belongs to a
   * browser visitor rather than to somebody with an account: the wire carries
   * membership ids and nothing else, and no server-side handler stands between
   * a grant and this machine - remote control is peer-to-peer end to end. So
   * `input-guard.ts` is the whole of the refusal, and this is what makes it
   * true of a real layup rather than only of a unit test.
   *
   * Fed from every layup state update, not only when the membership changes:
   * a guest who arrives mid-call is a guest from the moment the roster says so.
   */
  setParticipants(participants: readonly RosterParticipant[]): void;
  /**
   * Adopts the share the control plane already knows about.
   *
   * Live events only tell you what happens *next*: a desktop that starts, or
   * rejoins, while somebody is already presenting would otherwise show "nobody
   * is sharing" and offer to share, which the server then refuses.
   */
  adoptShare(share: unknown): void;
  /** Applies one screen-share event from the control plane. */
  applyShareEvent(type: string, payload: unknown): void;
  shareState(): ShareStateResponse;
  controlState(): RemoteControlStateResponse;
  startShare(sourceId: string): Promise<ShareStateResponse>;
  stopShare(): Promise<ShareStateResponse>;
  askToShare(): Promise<ShareStateResponse>;
  setAllowed(scope: ControlScope, allowed: boolean): RemoteControlStateResponse;
  /** Stops one person while the layup keeps sharing. */
  stop(membershipId: string): RemoteControlStateResponse;
  /** Lets a stopped person back in. */
  resume(membershipId: string): RemoteControlStateResponse;
  stopAll(): Promise<RemoteControlStateResponse>;
  /** Judges one message a peer sent. Never reports what was in it. */
  offer(fromMembershipId: string, message: unknown): Promise<{ injected: boolean; reason?: string }>;
  /** Lets go of everything a peer was holding. */
  peerLeft(membershipId: string): Promise<void>;
  dispose(): void;
}

export function createRemoteSession(options: RemoteSessionOptions): RemoteSession {
  const store: ShareStore = createShareStore({ membershipId: () => membershipId });
  let membershipId: string | undefined;
  let layupId: string | undefined;
  let guard: InputGuard | undefined;
  let control: RemoteControl | undefined;
  let router: RemoteInputRouter | undefined;
  let emergency: EmergencyRevoke | undefined;
  let armedShortcut: string | undefined;
  let sweeper: ReturnType<typeof setInterval> | undefined;
  // Guest memberships, as the control plane last described them. Held out
  // here rather than inside a guard so it survives the rebuild a new
  // membership triggers, and so the guard reads it live: a roster that
  // arrives after the guard was built still governs it.
  const guests = new Set<string>();

  const emptyControl: RemoteControlStateResponse = {
    allowed: { pointer: false, keyboard: false },
    stopped: [],
    anyoneHasControl: false,
  };

  function controlState(): RemoteControlStateResponse {
    if (!control) return emptyControl;
    return {
      ...control.state(),
      ...(armedShortcut ? { shortcut: armedShortcut } : {}),
    };
  }

  /** Everybody who might be holding something on this machine. */
  function holders(): string[] {
    const dragging = router?.dragging();
    const typing = router?.typing();
    return [...new Set([dragging, typing].filter((id): id is string => Boolean(id)))];
  }

  function announceControl() {
    options.onControlChanged(controlState());
  }

  function build() {
    teardown();
    if (!membershipId) return;

    guard = createInputGuard({
      localMembershipId: membershipId,
      isPresenting: () => store.isPresenting(),
      // The share's capture source doubles as the display identifier on the
      // wire: it is the one name both ends already agree on, and it is
      // meaningless anywhere except the presenter's own machine.
      sharedDisplayId: () => store.state().share?.sourceId,
      presenterMembershipId: () => store.state().share?.presenterMembershipId,
      allowsScope: (scope) => control?.isAllowed(scope) ?? false,
      // Sharing the mouse with "the room" never meant sharing it with a
      // stranger holding a link. Read on every message, so a roster update
      // takes effect without anything being rebuilt.
      isGuestMembership: (id) => guests.has(id),
    });

    control = createRemoteControl({
      membershipId,
      guard,
      broadcast: (message) => options.sendToPeers(message),
      release: (target) => {
        if (target) void router?.releaseFor(target, 'revoked');
      },
      isPresenting: () => store.isPresenting(),
    });

    router = createRemoteInputRouter({
      guard,
      helper: () => options.helper.client(),
      displays: options.displays,
      log: options.log,
    });

    emergency = createEmergencyRevoke({
      control,
      router,
      holders: () => holders(),
      log: options.log,
      ...(options.registerShortcut ? { register: options.registerShortcut } : {}),
      ...(options.unregisterShortcut ? { unregister: options.unregisterShortcut } : {}),
    });
    armedShortcut = emergency.arm() ? EMERGENCY_REVOKE_SHORTCUT : undefined;

    // Leases and notices both age out; nothing else drives a clock in the main
    // process, so one slow timer serves both.
    sweeper = setInterval(() => {
      if (router?.expireLeases()) announceControl();
      if (store.sweep()) options.onShareChanged(store.state() as ShareStateResponse);
    }, 500);
  }

  async function stopAll(): Promise<RemoteControlStateResponse> {
    await emergency?.trigger('button');
    const state = controlState();
    options.onControlChanged(state);
    return state;
  }

  function teardown() {
    if (sweeper) clearInterval(sweeper);
    sweeper = undefined;
    emergency?.disarm();
    armedShortcut = undefined;
    guard = undefined;
    control = undefined;
    router = undefined;
    emergency = undefined;
  }

  return {
    setParticipants(participants) {
      guests.clear();
      for (const participant of participants) {
        if (participant.isGuest) guests.add(participant.membershipId);
      }
    },


    setMembership(nextMembership, nextLayup) {
      if (nextMembership === membershipId && nextLayup === layupId) return;
      membershipId = nextMembership;
      layupId = nextLayup;
      build();
      announceControl();
    },

    adoptShare(share) {
      if (!share) return;
      if (!store.apply(TYPE_SCREEN_STARTED, share)) return;
      options.onShareChanged(store.state() as ShareStateResponse);
      announceControl();
    },

    applyShareEvent(type, payload) {
      if (!store.apply(type, payload)) return;
      const state = store.state() as ShareStateResponse;
      options.onShareChanged(state);
      // Losing the screen ends every grant that was bound to it: the switch is
      // about a share, not about the machine for ever after.
      if (!store.isPresenting() && control?.state().anyoneHasControl) {
        void stopAll();
      }
      announceControl();
    },

    shareState: () => store.state() as ShareStateResponse,
    controlState,

    async startShare(sourceId) {
      if (!layupId) throw new Error('you are not in a layup');
      const share = await options.client.startShare(layupId, sourceId);
      store.apply(TYPE_SCREEN_STARTED, share);
      const state = store.state() as ShareStateResponse;
      options.onShareChanged(state);
      announceControl();
      return state;
    },

    async stopShare() {
      if (!layupId) throw new Error('you are not in a layup');
      await options.client.stopShare(layupId);
      // Stopping is also a revoke: nobody keeps control of a screen that is no
      // longer being shared.
      await stopAll();
      store.apply(TYPE_SCREEN_STOPPED, {});
      const state = store.state() as ShareStateResponse;
      options.onShareChanged(state);
      return state;
    },

    async askToShare() {
      if (!layupId) throw new Error('you are not in a layup');
      await options.client.requestShare(layupId);
      return store.state() as ShareStateResponse;
    },

    setAllowed(scope, allowed) {
      control?.setAllowed(scope, allowed);
      const state = controlState();
      options.onControlChanged(state);
      return state;
    },

    stop(target) {
      control?.stop(target);
      const state = controlState();
      options.onControlChanged(state);
      return state;
    },

    resume(target) {
      control?.resume(target);
      const state = controlState();
      options.onControlChanged(state);
      return state;
    },

    stopAll,

    async offer(fromMembershipId, message) {
      if (!router) return { injected: false, reason: 'not-in-a-layup' };
      // Which peer it came from is decided here, from the connection it
      // arrived on - never from anything inside the message.
      const result = await router.handle(message, {
        membershipId: fromMembershipId,
        channel: CHANNEL_INPUT,
      });
      return result.reason ? { injected: result.injected, reason: result.reason } : { injected: result.injected };
    },

    async peerLeft(target) {
      await router?.releaseFor(target, 'disconnect');
      // Their stop, if any, goes with them: a membership that comes back is a
      // new one, and should not inherit a decision about somebody who left.
      guard?.forget(target);
      announceControl();
    },

    dispose: teardown,
  };
}
