/**
 * Remote-input protocol (SPEC.md §11 `input-reliable`, §13.3, ADR-0008).
 *
 *   pointer.down  pointer.up  pointer.click  pointer.wheel
 *   key.down      key.up
 *   control.grant control.revoke
 *   lease.acquire lease.release
 *
 * These are the destructive messages. A dropped click leaves a button held on
 * somebody else's machine and a reordered key-up types the wrong thing, so they
 * travel on the ordered, reliable channel - never on `cursor-fast`, where the
 * whole point is that stale packets are thrown away (ADR-0008).
 *
 * Two rules run through every message here:
 *
 *   - **Coordinates are normalised to the shared surface**, exactly like cursor
 *     movement, because the sender does not know the presenter's display
 *     geometry and must never guess at it. The presenter's own machine converts
 *     to pixels.
 *   - **Nothing in a message grants authority.** A `membershipId` is a claim
 *     about who is speaking, not permission to act; the presenter's machine
 *     decides what to allow from its own grant state (SPEC.md §7.3). Messages
 *     are validated for shape here and for authority in the desktop's guard.
 */
import {
  isEnum,
  isInteger,
  isNormalised,
  isObject,
  isString,
  optional,
  type Validator,
} from './validate';

export const TYPE_POINTER_DOWN = 'pointer.down';
export const TYPE_POINTER_UP = 'pointer.up';
export const TYPE_POINTER_CLICK = 'pointer.click';
export const TYPE_POINTER_WHEEL = 'pointer.wheel';
export const TYPE_KEY_DOWN = 'key.down';
export const TYPE_KEY_UP = 'key.up';
export const TYPE_CONTROL_GRANT = 'control.grant';
export const TYPE_CONTROL_REVOKE = 'control.revoke';
export const TYPE_LEASE_ACQUIRE = 'lease.acquire';
export const TYPE_LEASE_RELEASE = 'lease.release';

/**
 * Version of the input message set.
 *
 * Carried on every message because the two ends of a layup can be running
 * different builds: a peer that does not understand a version must refuse it
 * rather than interpret unfamiliar fields as input.
 */
export const INPUT_PROTOCOL_VERSION = 1;

/** A wheel notch. More than this in one message is a runaway sender. */
export const MAX_WHEEL_DELTA = 120;
/** Longest key name accepted; real `KeyboardEvent.code` values are far shorter. */
export const MAX_KEY_CODE_LENGTH = 32;
/** More clicks than any double- or triple-click gesture needs. */
export const MAX_CLICK_COUNT = 3;

/** What a grant covers. Pointer and keyboard are granted separately. */
export const CONTROL_SCOPES = ['pointer', 'keyboard'] as const;
export type ControlScope = (typeof CONTROL_SCOPES)[number];

export const POINTER_BUTTONS = ['left', 'right', 'middle'] as const;
export type PointerButton = (typeof POINTER_BUTTONS)[number];

const version = isInteger({ min: 1, max: 1_000 });
const sequence = isInteger({ min: 0 });

export const pointerDown = isObject({
  type: isEnum([TYPE_POINTER_DOWN] as const),
  v: version,
  /** Who is claiming to act. Checked against the peer, never trusted alone. */
  membershipId: isString,
  /** Which display of the shared surface, for a multi-display presenter. */
  displayId: isString,
  x: isNormalised,
  y: isNormalised,
  button: isEnum(POINTER_BUTTONS),
  /** Monotonic per sender: a replayed or reordered action is refused. */
  seq: sequence,
});
export type PointerDown = ReturnType<typeof pointerDown>;

export const pointerUp = isObject({
  type: isEnum([TYPE_POINTER_UP] as const),
  v: version,
  membershipId: isString,
  displayId: isString,
  x: isNormalised,
  y: isNormalised,
  button: isEnum(POINTER_BUTTONS),
  seq: sequence,
});
export type PointerUp = ReturnType<typeof pointerUp>;

export const pointerClick = isObject({
  type: isEnum([TYPE_POINTER_CLICK] as const),
  v: version,
  membershipId: isString,
  displayId: isString,
  x: isNormalised,
  y: isNormalised,
  button: isEnum(POINTER_BUTTONS),
  /** 2 for a double-click, 3 for a triple. */
  clickCount: optional(isInteger({ min: 1, max: MAX_CLICK_COUNT })),
  seq: sequence,
});
export type PointerClick = ReturnType<typeof pointerClick>;

export const pointerWheel = isObject({
  type: isEnum([TYPE_POINTER_WHEEL] as const),
  v: version,
  membershipId: isString,
  displayId: isString,
  x: isNormalised,
  y: isNormalised,
  deltaX: isInteger({ min: -MAX_WHEEL_DELTA, max: MAX_WHEEL_DELTA }),
  deltaY: isInteger({ min: -MAX_WHEEL_DELTA, max: MAX_WHEEL_DELTA }),
  seq: sequence,
});
export type PointerWheel = ReturnType<typeof pointerWheel>;

export const keyDown = isObject({
  type: isEnum([TYPE_KEY_DOWN] as const),
  v: version,
  membershipId: isString,
  /**
   * A `KeyboardEvent.code` - a physical key position, not a character.
   *
   * The code is all that travels. Typed *content* is never a protocol concept:
   * it is not sent as text, not logged and not audited (SPEC.md §13.4).
   */
  code: isString,
  seq: sequence,
});
export type KeyDown = ReturnType<typeof keyDown>;

export const keyUp = isObject({
  type: isEnum([TYPE_KEY_UP] as const),
  v: version,
  membershipId: isString,
  code: isString,
  seq: sequence,
});
export type KeyUp = ReturnType<typeof keyUp>;

export const controlGrant = isObject({
  type: isEnum([TYPE_CONTROL_GRANT] as const),
  v: version,
  /** The presenter issuing the grant; only they may. */
  membershipId: isString,
  /**
   * Who is being granted control. Absent means everyone in the layup.
   *
   * Sharing control is a mode, not a list of permissions: the presenter says
   * "the mouse is shared" and it is shared with the room. Naming one person is
   * the exception - used to put somebody back after they were stopped.
   */
  targetMembershipId: optional(isString),
  scope: isEnum(CONTROL_SCOPES),
  /**
   * Identifies this grant. A revoke names it, so a revoke that races a re-grant
   * cannot cancel the newer one.
   */
  grantId: isString,
  seq: sequence,
});
export type ControlGrant = ReturnType<typeof controlGrant>;

export const controlRevoke = isObject({
  type: isEnum([TYPE_CONTROL_REVOKE] as const),
  v: version,
  membershipId: isString,
  /** Absent revokes everyone - the emergency stop (SPEC.md §13.3). */
  targetMembershipId: optional(isString),
  scope: optional(isEnum(CONTROL_SCOPES)),
  grantId: optional(isString),
  seq: sequence,
});
export type ControlRevoke = ReturnType<typeof controlRevoke>;

export const leaseAcquire = isObject({
  type: isEnum([TYPE_LEASE_ACQUIRE] as const),
  v: version,
  membershipId: isString,
  scope: isEnum(CONTROL_SCOPES),
  seq: sequence,
});
export type LeaseAcquire = ReturnType<typeof leaseAcquire>;

export const leaseRelease = isObject({
  type: isEnum([TYPE_LEASE_RELEASE] as const),
  v: version,
  membershipId: isString,
  scope: isEnum(CONTROL_SCOPES),
  seq: sequence,
});
export type LeaseRelease = ReturnType<typeof leaseRelease>;

export type PointerMessage = PointerDown | PointerUp | PointerClick | PointerWheel;
export type KeyMessage = KeyDown | KeyUp;
export type ControlMessage = ControlGrant | ControlRevoke;
export type LeaseMessage = LeaseAcquire | LeaseRelease;
export type InputMessage = PointerMessage | KeyMessage | ControlMessage | LeaseMessage;

const VALIDATORS: Record<string, Validator<InputMessage>> = {
  [TYPE_POINTER_DOWN]: pointerDown as Validator<InputMessage>,
  [TYPE_POINTER_UP]: pointerUp as Validator<InputMessage>,
  [TYPE_POINTER_CLICK]: pointerClick as Validator<InputMessage>,
  [TYPE_POINTER_WHEEL]: pointerWheel as Validator<InputMessage>,
  [TYPE_KEY_DOWN]: keyDown as Validator<InputMessage>,
  [TYPE_KEY_UP]: keyUp as Validator<InputMessage>,
  [TYPE_CONTROL_GRANT]: controlGrant as Validator<InputMessage>,
  [TYPE_CONTROL_REVOKE]: controlRevoke as Validator<InputMessage>,
  [TYPE_LEASE_ACQUIRE]: leaseAcquire as Validator<InputMessage>,
  [TYPE_LEASE_RELEASE]: leaseRelease as Validator<InputMessage>,
};

/**
 * Validates any input message by its `type`. Throws on anything unknown or
 * from a version this build does not implement.
 *
 * Refusing an unknown version matters more here than anywhere else in the
 * protocol: guessing at the meaning of an unfamiliar field would mean guessing
 * at what to do to somebody else's machine.
 */
export function decodeInput(raw: unknown): InputMessage {
  const type = (raw as { type?: unknown })?.type;
  const validator = typeof type === 'string' ? VALIDATORS[type] : undefined;
  if (!validator) {
    throw new (class extends Error {})(`unknown input message ${String(type)}`);
  }
  const message = validator(raw, String(type));
  if (message.v !== INPUT_PROTOCOL_VERSION) {
    throw new (class extends Error {})(
      `input protocol version ${message.v} is not supported (this build speaks ${INPUT_PROTOCOL_VERSION})`,
    );
  }
  if (isKeyMessage(message) && !isPlausibleKeyCode(message.code)) {
    throw new (class extends Error {})('key code is not a KeyboardEvent.code');
  }
  return message;
}

export function isPointerMessage(message: InputMessage): message is PointerMessage {
  return (
    message.type === TYPE_POINTER_DOWN ||
    message.type === TYPE_POINTER_UP ||
    message.type === TYPE_POINTER_CLICK ||
    message.type === TYPE_POINTER_WHEEL
  );
}

export function isKeyMessage(message: InputMessage): message is KeyMessage {
  return message.type === TYPE_KEY_DOWN || message.type === TYPE_KEY_UP;
}

export function isControlMessage(message: InputMessage): message is ControlMessage {
  return message.type === TYPE_CONTROL_GRANT || message.type === TYPE_CONTROL_REVOKE;
}

export function isLeaseMessage(message: InputMessage): message is LeaseMessage {
  return message.type === TYPE_LEASE_ACQUIRE || message.type === TYPE_LEASE_RELEASE;
}

/** The scope a message needs before it may be acted on. */
export function scopeOf(message: InputMessage): ControlScope | undefined {
  if (isPointerMessage(message)) return 'pointer';
  if (isKeyMessage(message)) return 'keyboard';
  return undefined;
}

/**
 * Whether a string looks like a `KeyboardEvent.code`.
 *
 * The injector holds the real list - this only keeps obvious nonsense, and
 * anything long enough to be typed *content* rather than a key name, off the
 * wire.
 */
export function isPlausibleKeyCode(code: string): boolean {
  return code.length > 0 && code.length <= MAX_KEY_CODE_LENGTH && /^[A-Za-z][A-Za-z0-9]*$/.test(code);
}
