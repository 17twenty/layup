import { beforeEach, describe, expect, it } from 'vitest';
import {
  TYPE_SCREEN_SETTINGS,
  TYPE_SCREEN_SHARE_REQUEST,
  TYPE_SCREEN_STARTED,
  TYPE_SCREEN_STOPPED,
  TYPE_SCREEN_TAKEOVER,
  createShareStore,
  type ShareStore,
} from './share-store';

const ME = 'mem_me';
const share = (presenterMembershipId: string, id = 'shr_1') => ({
  id,
  presenterMembershipId,
  allowDrawing: true,
  allowPointer: false,
  allowKeyboard: false,
});

let clock = 0;
let store: ShareStore;

beforeEach(() => {
  clock = 1_000;
  store = createShareStore({ membershipId: () => ME, noticeMs: 8_000, now: () => clock });
});

describe('share store', () => {
  it('holds one share, or none', () => {
    expect(store.state().share).toBeUndefined();
    expect(store.isPresenting()).toBe(false);

    store.apply(TYPE_SCREEN_STARTED, share('mem_karl'));
    expect(store.state().share?.presenterMembershipId).toBe('mem_karl');
    expect(store.isPresenting()).toBe(false);

    // Somebody else taking over replaces it; there is never a second screen.
    store.apply(TYPE_SCREEN_STARTED, share(ME, 'shr_2'));
    expect(store.state().share?.id).toBe('shr_2');
    expect(store.isPresenting()).toBe(true);

    // And nobody sharing is a normal state, not an error.
    store.apply(TYPE_SCREEN_STOPPED, {});
    expect(store.state().share).toBeUndefined();
    expect(store.isPresenting()).toBe(false);
  });

  it('tells the person who lost the screen, in a sentence', () => {
    store.apply(TYPE_SCREEN_STARTED, share(ME));
    expect(store.isPresenting()).toBe(true);

    store.apply(TYPE_SCREEN_TAKEOVER, { takenByName: 'Karl' });

    // Taking over needs no approval, which only works if the person who lost
    // the screen finds out at once.
    expect(store.state().notice).toMatchObject({
      kind: 'takeover',
      text: 'Karl is sharing their screen now.',
    });
    expect(store.state().share).toBeUndefined();
    expect(store.isPresenting()).toBe(false);
  });

  it('passes on a request to share without changing anything', () => {
    store.apply(TYPE_SCREEN_STARTED, share(ME));
    store.apply(TYPE_SCREEN_SHARE_REQUEST, { askedByName: 'Sam', askedByMembershipId: 'mem_sam' });

    expect(store.state().notice).toMatchObject({
      kind: 'ask-to-share',
      text: 'Sam would like to share their screen.',
      membershipId: 'mem_sam',
    });
    // Asking is not taking: the share is untouched.
    expect(store.isPresenting()).toBe(true);
  });

  it('lets a notice fade on its own', () => {
    store.apply(TYPE_SCREEN_TAKEOVER, { takenByName: 'Karl' });
    expect(store.sweep()).toBe(false);

    clock += 8_000;
    expect(store.sweep()).toBe(true);
    expect(store.state().notice).toBeUndefined();
    // Nothing to sweep twice.
    expect(store.sweep()).toBe(false);
  });

  it("follows the presenter's safety switches", () => {
    store.apply(TYPE_SCREEN_STARTED, share('mem_karl'));
    store.apply(TYPE_SCREEN_SETTINGS, { ...share('mem_karl'), allowDrawing: false, allowPointer: true });

    expect(store.state().share).toMatchObject({ allowDrawing: false, allowPointer: true });
  });

  it('ignores events it does not understand, and junk', () => {
    expect(store.apply('layup.changed', {})).toBe(false);
    expect(store.apply(TYPE_SCREEN_STARTED, undefined)).toBe(false);
    expect(store.apply(TYPE_SCREEN_STOPPED, {})).toBe(false);
    expect(store.state()).toEqual({});
  });

  it('tells the interface when anything changes', () => {
    const seen: Array<string | undefined> = [];
    const unsubscribe = store.subscribe((state) => seen.push(state.share?.presenterMembershipId));

    store.apply(TYPE_SCREEN_STARTED, share('mem_karl'));
    store.apply(TYPE_SCREEN_STOPPED, {});
    unsubscribe();
    store.apply(TYPE_SCREEN_STARTED, share(ME));

    expect(seen).toEqual(['mem_karl', undefined]);
  });
});
