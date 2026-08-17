/**
 * The stop button that always works (SPEC.md §13.3).
 *
 * Everything else about remote control is a negotiation - switches, grants,
 * leases. This is not. It is one action that ends all of it, and it is designed
 * around the moment somebody actually needs it: a remote participant is doing
 * something alarming and the presenter is not looking at the right window, or
 * any window. So it is a **global** shortcut, it takes no confirmation, and it
 * does the local half first: grants are withdrawn and held input is released
 * before anybody is told, because a message that arrives late must not be what
 * stands between a person and their own machine.
 *
 * It is also deliberately not a keystroke this code has to watch for. Electron
 * registers the accelerator with the OS; nothing here reads what the presenter
 * types (SPEC.md §13.4).
 */
import type { RemoteControl } from '../core/remote-control';
import type { RemoteInputRouter } from './remote-input';
import type { Logger } from './logging';

/**
 * Chosen to be unreachable by accident and impossible to hit while typing:
 * three modifiers and a key nothing else claims.
 *
 * The key is the literal character, not a name. Electron accelerators take
 * punctuation as itself (`\\`), and reject names like "Backslash" by throwing
 * rather than returning false - which is why arming is also wrapped below.
 */
export const EMERGENCY_REVOKE_SHORTCUT = 'CommandOrControl+Alt+Shift+\\';

export type EmergencyCause = 'shortcut' | 'button' | 'share-ended';

export interface EmergencyRevokeOptions {
  control: RemoteControl;
  router: RemoteInputRouter;
  /** Everybody who might be holding something. */
  holders: () => string[];
  log: Logger;
  /** Registers the OS-level shortcut. Injected so this is testable. */
  register?: (accelerator: string, handler: () => void) => boolean;
  unregister?: (accelerator: string) => void;
}

export interface EmergencyRevokeResult {
  /** How many grants were withdrawn. */
  revoked: number;
  cause: EmergencyCause;
}

export interface EmergencyRevoke {
  /** Registers the global shortcut. Returns false when the OS refused it. */
  arm(): boolean;
  disarm(): void;
  armed(): boolean;
  trigger(cause: EmergencyCause): Promise<EmergencyRevokeResult>;
}

export function createEmergencyRevoke(options: EmergencyRevokeOptions): EmergencyRevoke {
  let armed = false;

  async function trigger(cause: EmergencyCause): Promise<EmergencyRevokeResult> {
    // Order matters. Withdraw first, so the guard refuses the very next
    // message; then let go of everything held; then tell people.
    const revoked = options.control.stopAll();
    for (const membershipId of options.holders()) {
      await options.router.releaseFor(membershipId, 'revoked');
    }
    // Treat it as local input too: nothing remote acts for the moment after,
    // so a message already in flight cannot land as the presenter takes over.
    options.router.localInput();
    await options.router.settle();

    // An audit event, not a keystroke: "remote control revoked" is on the list
    // of things worth recording (SPEC.md §13.4).
    options.log.warn('remote control revoked', { cause, grants: revoked });
    return { revoked, cause };
  }

  return {
    arm() {
      if (armed) return true;
      const register = options.register;
      if (!register) return false;
      try {
        armed = register(EMERGENCY_REVOKE_SHORTCUT, () => void trigger('shortcut'));
      } catch (error) {
        // A refusal must never be worse than not having the shortcut: losing
        // the accelerator cannot be allowed to break the layup around it.
        armed = false;
        options.log.warn('the emergency revoke shortcut was rejected outright', {
          shortcut: EMERGENCY_REVOKE_SHORTCUT,
          reason: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      if (!armed) {
        // Another application already owns the combination. Say so plainly:
        // the on-screen stop button is still there, and a person who thinks
        // they have a panic key that does nothing is worse off than one who
        // knows they do not.
        options.log.warn('the emergency revoke shortcut could not be registered', {
          shortcut: EMERGENCY_REVOKE_SHORTCUT,
        });
      }
      return armed;
    },

    disarm() {
      if (!armed) return;
      options.unregister?.(EMERGENCY_REVOKE_SHORTCUT);
      armed = false;
    },

    armed: () => armed,

    trigger,
  };
}
