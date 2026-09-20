import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INPUT_PROTOCOL_VERSION, TYPE_POINTER_CLICK, type ControlMessage } from '@layup/protocol';
import { TYPE_SCREEN_STARTED, TYPE_SCREEN_STOPPED, TYPE_SCREEN_TAKEOVER } from '../core/share-store';
import { createLogger } from './logging';
import { createRemoteSession, type RemoteSession } from './remote-session';
import type { ControlClient } from '../core/control-client';
import type { HelperClient, HelperResponse } from './helper-client';
import type { HelperSupervisor } from './helper-supervisor';

const ME = 'mem_me';
const GUEST = 'mem_guest';
/** A browser visitor who arrived by link - not somebody with an account. */
const WEB_GUEST = 'mem_web_guest';
const SOURCE = 'screen:1:0';

let injected: Array<{ command: string; payload: unknown }>;
let broadcastToPeers: ControlMessage[];
let controlStates: unknown[];
let session: RemoteSession;
let seq = 0;

const helperClient: HelperClient = {
  connect: async () => {},
  send: async (command, payload): Promise<HelperResponse> => {
    injected.push({ command, payload });
    return { ok: true };
  },
  capabilities: async () => undefined,
  close: () => {},
  connected: () => true,
};

const share = {
  id: 'shr_1',
  presenterMembershipId: ME,
  sourceId: SOURCE,
  allowDrawing: true,
  allowPointer: false,
  allowKeyboard: false,
};

const client = {
  startShare: vi.fn(async () => share),
  stopShare: vi.fn(async () => undefined),
  requestShare: vi.fn(async () => ({ layupId: 'lay_1', shareId: 'shr_1', askedByMembershipId: GUEST })),
} as unknown as ControlClient;

function click(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    type: TYPE_POINTER_CLICK,
    v: INPUT_PROTOCOL_VERSION,
    membershipId: GUEST,
    displayId: SOURCE,
    x: 0.5,
    y: 0.5,
    button: 'left',
    seq,
    ...overrides,
  };
}

beforeEach(() => {
  injected = [];
  broadcastToPeers = [];
  controlStates = [];
  seq = 0;
  vi.clearAllMocks();

  session = createRemoteSession({
    client,
    helper: { client: () => helperClient } as unknown as HelperSupervisor,
    displays: () => [{ displayId: SOURCE, x: 0, y: 0, width: 1000, height: 500 }],
    log: createLogger({ level: 'error', write: () => {} }),
    onShareChanged: () => {},
    onControlChanged: (state) => controlStates.push(state),
    sendToPeers: (message) => broadcastToPeers.push(message),
    // No OS accelerator in tests: the button half must work on its own.
  });

  session.setMembership(ME, 'lay_1');
});

describe('the privileged half of a layup', () => {
  it("refuses a peer's action until the presenter allows and grants it", async () => {
    // Not even sharing yet.
    expect(await session.offer(GUEST, click())).toMatchObject({ injected: false });

    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    expect(await session.offer(GUEST, click())).toMatchObject({ injected: false });

    // Sharing the mouse shares it with the room: nobody had to be named.
    session.setAllowed('pointer', true);
    expect(await session.offer(GUEST, click())).toEqual({ injected: true });
    expect(injected).toEqual([
      { command: 'pointer.move', payload: { x: 500, y: 250 } },
      { command: 'pointer.button', payload: { button: 'left', down: true } },
      { command: 'pointer.button', payload: { button: 'left', down: false } },
    ]);
  });

  it('tells the peers about every grant and revoke', async () => {
    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    session.setAllowed('pointer', true);
    // Shared with the room: the announcement names no one.
    expect(broadcastToPeers.at(-1)).toMatchObject({ type: 'control.grant', scope: 'pointer' });

    await session.stopAll();
    expect(broadcastToPeers.at(-1)).toMatchObject({ type: 'control.revoke' });
    expect(session.controlState().anyoneHasControl).toBe(false);
  });

  it('ends control when the screen stops being shared', async () => {
    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    session.setAllowed('pointer', true);
    expect(session.controlState().anyoneHasControl).toBe(true);

    session.applyShareEvent(TYPE_SCREEN_STOPPED, {});
    await Promise.resolve();

    // A grant is for a share, not for the machine for ever after.
    expect(session.controlState().anyoneHasControl).toBe(false);
    expect(await session.offer(GUEST, click())).toMatchObject({ injected: false });
  });

  it('ends control when somebody else takes the screen', async () => {
    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    session.setAllowed('keyboard', true);

    session.applyShareEvent(TYPE_SCREEN_TAKEOVER, { takenByName: 'Karl' });
    await Promise.resolve();
    expect(session.controlState().anyoneHasControl).toBe(false);
  });

  it('carries nothing over from one layup to the next', async () => {
    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    session.setAllowed('pointer', true);

    session.setMembership('mem_other', 'lay_2');

    expect(session.controlState()).toMatchObject({
      allowed: { pointer: false, keyboard: false },
      stopped: [],
    });
    // And leaving entirely leaves nothing that could act.
    session.setMembership(undefined, undefined);
    expect(await session.offer(GUEST, click())).toEqual({ injected: false, reason: 'not-in-a-layup' });
  });

  it('lets go of what a departing peer was holding', async () => {
    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    session.setAllowed('pointer', true);
    await session.offer(GUEST, click({ type: 'pointer.down' }));
    injected = [];

    await session.peerLeft(GUEST);

    expect(injected).toEqual([{ command: 'pointer.button', payload: { button: 'left', down: false } }]);
    // The machine is still shared - somebody leaving is not the presenter
    // changing their mind - but nothing of theirs is left holding it.
    expect(session.controlState().anyoneHasControl).toBe(true);
    expect(session.controlState().stopped).toEqual([]);
  });

  it('never hands a guest the mouse, whatever the room-wide switch says', async () => {
    // The layup as the control plane describes it: one member, one guest.
    // This is the only place the desktop can learn the difference - the wire
    // carries membership ids and nothing else.
    session.setParticipants([
      { membershipId: ME, isGuest: false },
      { membershipId: GUEST, isGuest: false },
      { membershipId: WEB_GUEST, isGuest: true },
    ]);
    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    // Shared with the room. "The room" has never meant a stranger holding a URL.
    session.setAllowed('pointer', true);

    // A member in the same room, under the same switch, is allowed.
    expect(await session.offer(GUEST, click())).toEqual({ injected: true });
    injected = [];

    expect(await session.offer(WEB_GUEST, click({ membershipId: WEB_GUEST }))).toEqual({
      injected: false,
      reason: 'guest',
    });
    expect(injected).toEqual([]);
  });

  it('refuses a grant that names a guest, even one the presenter typed', async () => {
    session.setParticipants([
      { membershipId: ME, isGuest: false },
      { membershipId: WEB_GUEST, isGuest: true },
    ]);
    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    session.setAllowed('pointer', true);

    // resume() broadcasts a control.grant naming that membership - the most
    // direct way a guest could ever be named in a grant on this machine.
    session.stop(WEB_GUEST);
    session.resume(WEB_GUEST);
    expect(broadcastToPeers.at(-1)).toMatchObject({
      type: 'control.grant',
      targetMembershipId: WEB_GUEST,
    });

    // The announcement went out; the authority did not.
    expect(await session.offer(WEB_GUEST, click({ membershipId: WEB_GUEST }))).toEqual({
      injected: false,
      reason: 'guest',
    });
    expect(injected).toEqual([]);
  });

  it('learns who is a guest before it is asked to judge anything', async () => {
    // A guest who joins mid-call is a guest from that moment: the set is fed
    // from every layup state update, not only at membership time.
    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    session.setAllowed('pointer', true);
    session.setParticipants([{ membershipId: WEB_GUEST, isGuest: true }]);

    expect(await session.offer(WEB_GUEST, click({ membershipId: WEB_GUEST }))).toEqual({
      injected: false,
      reason: 'guest',
    });
  });

  it('stops the share through the control plane, and revokes with it', async () => {
    session.applyShareEvent(TYPE_SCREEN_STARTED, share);
    session.setAllowed('pointer', true);

    await session.stopShare();

    expect(client.stopShare).toHaveBeenCalledWith('lay_1');
    expect(session.shareState().share).toBeUndefined();
    expect(session.controlState().anyoneHasControl).toBe(false);
  });
});
