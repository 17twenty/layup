import {
  layupShape,
  type ControlClient,
  type CreateLayupInput,
  type Layup,
} from '../core/control-client';
import type { RealtimeClient } from '../core/realtime-client';
import type { Logger } from './logging';

/** Realtime message carrying the state of a layup to its participants. */
export const TYPE_LAYUP_STATE = 'layup.state';

/** What the desktop knows about the layup it is currently in. */
export interface LayupState {
  /** Undefined when this desktop is not in a layup. */
  layup?: Layup;
  /** Which membership this desktop is, in the current layup. */
  membershipId?: string;
  /** True while this desktop's own membership holds creator authority. */
  youAreCreatorMembership: boolean;
  /**
   * How camera and microphone should start for this join (SPEC.md §4). Absent
   * until this desktop has actually joined something.
   */
  media?: { camera: boolean; microphone: boolean; participantCount: number; mutedByThreshold: boolean };
}

export interface LayupSupervisorOptions {
  client: ControlClient;
  realtime: RealtimeClient;
  log: Logger;
  onChange?: (state: LayupState) => void;
}

export interface LayupSupervisor {
  state(): LayupState;
  /** Adopts a layup this desktop entered through some other path (an accepted
   *  invitation), so local state matches the server immediately. */
  adopt(layup: Layup, membershipId: string, media?: LayupState['media']): LayupState;
  create(input?: CreateLayupInput): Promise<LayupState>;
  join(layupId: string): Promise<LayupState>;
  leave(): Promise<LayupState>;
}

/**
 * Owns "which layup am I in" for this desktop.
 *
 * Creator authority is reported from the layup, never remembered locally: once
 * the server says authority is gone, it is gone here too (SPEC.md §2.2).
 */
export function createLayupSupervisor(options: LayupSupervisorOptions): LayupSupervisor {
  const { client, realtime, log } = options;

  let state: LayupState = { youAreCreatorMembership: false };

  function publish(next: LayupState) {
    state = next;
    options.onChange?.(state);
  }

  function derive(layup: Layup | undefined, membershipId: string | undefined): LayupState {
    if (!layup || !layup.active || !membershipId) {
      return { youAreCreatorMembership: false };
    }
    const stillIn = layup.participants.some(
      (participant) => participant.membershipId === membershipId && !participant.leftAt,
    );
    if (!stillIn) {
      return { youAreCreatorMembership: false };
    }
    return {
      layup,
      membershipId,
      youAreCreatorMembership: layup.creatorMembershipId === membershipId,
    };
  }

  // Membership changes made by anyone in the layup arrive here.
  realtime.on(TYPE_LAYUP_STATE, (message) => {
    try {
      const layup = layupShape(message.payload, TYPE_LAYUP_STATE);
      if (state.layup && layup.id !== state.layup.id) return;
      publish(derive(layup, state.membershipId));
      log.debug('layup state updated', {
        layupId: layup.id,
        active: layup.active,
        participants: layup.participants.filter((p) => !p.leftAt).length,
        hasCreatorAuthority: layup.hasCreatorAuthority,
      });
    } catch (error) {
      log.warn('rejected layup state', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return {
    state: () => state,

    adopt(layup, membershipId, media) {
      const next = derive(layup, membershipId);
      publish(media ? { ...next, media } : next);
      return state;
    },

    async create(input) {
      const result = await client.createLayup(input);
      log.info('layup created', {
        layupId: result.layup.id,
        visibility: result.layup.visibility,
        membershipId: result.yourMembershipId,
      });
      publish({ ...derive(result.layup, result.yourMembershipId), ...(result.media ? { media: result.media } : {}) });
      return state;
    },

    async join(layupId) {
      const result = await client.joinLayup(layupId);
      log.info('layup joined', {
        layupId,
        membershipId: result.yourMembershipId,
        cameraOnJoin: result.media?.camera,
        microphoneOnJoin: result.media?.microphone,
      });
      publish({ ...derive(result.layup, result.yourMembershipId), ...(result.media ? { media: result.media } : {}) });
      return state;
    },

    async leave() {
      const current = state.layup;
      if (!current) return state;
      const result = await client.leaveLayup(current.id);
      log.info('layup left', {
        layupId: current.id,
        stillActive: result.layup.active,
        hasCreatorAuthority: result.layup.hasCreatorAuthority,
      });
      publish({ youAreCreatorMembership: false });
      return state;
    },
  };
}
