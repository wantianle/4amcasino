import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '@4am/shared';

/**
 * Behaviour lock for the `handEffectsReducer` extraction - the second step of
 * the `handle()` decomposition.
 *
 * These are **representative result assertions** over the public `handle()`
 * entry point: for each moved frame they pin the resulting `HandView` state AND
 * the sequence of sounds the runner actually played. They are NOT a
 * byte-for-byte old/new snapshot diff; no double-execution harness backs them.
 * The extraction was reviewed by reading the old switch and the new
 * reducer+runner side by side, and these assertions lock the observable
 * `(input frame -> state + effects)` contract.
 */

const socket = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(),
  consumeResync: vi.fn(() => false),
}));
const sounds = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock('../src/shared/ws.ts', () => ({ wsClient: socket }));
vi.mock('../src/shared/voice.ts', () => ({ voice: { syncPeers: vi.fn(), handleRtc: vi.fn() } }));
vi.mock('../src/shared/sounds.ts', () => ({ play: sounds.play }));
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
vi.stubGlobal('window', { localStorage: storage, dispatchEvent: () => {} });
vi.stubGlobal('localStorage', storage);
vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
const session = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
vi.stubGlobal('sessionStorage', session);

const { useStore } = await import('../src/shared/store.ts');
const { handle, __resetHandTrackingForTest } = await import('../src/shared/gameClient.ts');
const { handEffectsReducer } = await import('../src/shared/handEffectsReducer.ts');

/** Sounds played since the last clear, as `name` strings in call order. */
function played(): string[] {
  return sounds.play.mock.calls.map((c) => c[0] as string);
}

/** Runs `fn` while recording the interleaving of store writes and sound plays.
 *  The runner applies the patch before it runs the effects, so a single frame
 *  with a sound must log `['write', 'play']`, never `['play', 'write']`. */
function recordOrder(fn: () => void): string[] {
  const order: string[] = [];
  sounds.play.mockImplementation(() => {
    order.push('play');
  });
  const unsub = useStore.subscribe(() => {
    order.push('write');
  });
  try {
    fn();
  } finally {
    unsub();
  }
  return order;
}

/** Counts store notifications for `fn` - a frame that early-returns produces
 *  zero, which distinguishes it from a write of an identical value. */
function countWrites(fn: () => void): number {
  let n = 0;
  const unsub = useStore.subscribe(() => {
    n++;
  });
  try {
    fn();
  } finally {
    unsub();
  }
  return n;
}

beforeEach(() => {
  sounds.play.mockReset();
  socket.send.mockClear();
  __resetHandTrackingForTest();
  useStore.getState().resetHand();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('handEffectsReducer: rit_offer', () => {
  it('opens the vote and plays the turn cue', () => {
    const result = recordOrder(() => {
      handle({ t: 'rit_offer', handId: 'h-rit', deadlineTs: 111, voters: [0, 2] });
    });
    expect(useStore.getState().hand.ritOffer).toEqual({ deadlineTs: 111, voters: [0, 2], voted: false });
    expect(played()).toEqual(['turn']);
    expect(result).toEqual(['write', 'play']);
  });
});

describe('handEffectsReducer: rit_result', () => {
  it('run-twice: fills both runs and plays the chip cue', () => {
    useStore.getState().patchHand({
      handId: 'h-rit',
      ritOffer: { deadlineTs: 1, voters: [0], voted: true },
    });
    const result = recordOrder(() => {
      handle({ t: 'rit_result', handId: 'h-rit', runTwice: true, sharedBoard: [1, 2, 3, 4, 5] });
    });
    const h = useStore.getState().hand;
    expect(h.ritOffer).toBeNull();
    expect(h.boards).toEqual([[1, 2, 3, 4, 5], [1, 2, 3, 4, 5]]);
    expect(h.board).toEqual([1, 2, 3, 4, 5]);
    expect(h.board2).toEqual([1, 2, 3, 4, 5]);
    expect(played()).toEqual(['chip']);
    expect(result).toEqual(['write', 'play']);
  });

  it('single run: leaves run 2 empty and plays nothing', () => {
    handle({ t: 'rit_result', handId: 'h-rit', runTwice: false, sharedBoard: [9, 10] });
    const h = useStore.getState().hand;
    expect(h.boards).toEqual([[9, 10], []]);
    expect(h.board).toEqual([9, 10]);
    expect(h.board2).toEqual([]);
    expect(played()).toEqual([]);
  });

  it('copies the shared board - mutating the frame later does not touch state', () => {
    const sharedBoard = [1, 2, 3];
    handle({ t: 'rit_result', handId: 'h-rit', runTwice: true, sharedBoard });
    sharedBoard.push(99);
    expect(useStore.getState().hand.boards).toEqual([[1, 2, 3], [1, 2, 3]]);
  });
});

describe('handEffectsReducer: multi_run_offer', () => {
  const base = {
    t: 'multi_run_offer' as const,
    handId: 'h-mr',
    decisionId: 'd1',
    stage: 'choice' as const,
    aheadSeat: 1,
    behindSeat: 3,
    equities: [{ seat: 1, bps: 6000 }, { seat: 3, bps: 4000 }],
    deadlineTs: 222,
  };

  it('stores the full snapshot including requestedRuns and plays the turn cue', () => {
    const result = recordOrder(() => {
      handle({ ...base, requestedRuns: 2 });
    });
    expect(useStore.getState().hand.multiRunOffer).toEqual({ ...base, requestedRuns: 2 });
    expect(played()).toEqual(['turn']);
    expect(result).toEqual(['write', 'play']);
  });

  it('omits requestedRuns entirely when the frame has not chosen yet', () => {
    handle(base);
    const offer = useStore.getState().hand.multiRunOffer as Record<string, unknown>;
    expect(offer).toEqual(base);
    expect('requestedRuns' in offer).toBe(false);
  });

  it('overwrites a previous offer rather than merging (reconnect replay)', () => {
    handle({ ...base, requestedRuns: 3 });
    handle({ ...base, stage: 'agreement', decisionId: 'd2' });
    const offer = useStore.getState().hand.multiRunOffer as Record<string, unknown>;
    expect(offer.decisionId).toBe('d2');
    expect(offer.stage).toBe('agreement');
    expect('requestedRuns' in offer).toBe(false);
  });
});

describe('handEffectsReducer: squid_result', () => {
  it('stores the result verbatim and plays the chip cue', () => {
    const msg = {
      t: 'squid_result' as const,
      handId: 'h-squid',
      winners: [1],
      transfers: [{ from: 3, to: 1, amount: 5 }],
      requestedPerLoser: 5,
      paidBySeat: [{ seat: 3, amount: 5 }],
      netBySeat: [{ seat: 1, net: 5 }],
      noClaimant: false,
    };
    const result = recordOrder(() => {
      handle(msg);
    });
    expect(useStore.getState().hand.squidResult).toBe(msg);
    expect(played()).toEqual(['chip']);
    expect(result).toEqual(['write', 'play']);
  });
});

describe('handEffectsReducer: peek_offer', () => {
  it('appends an incoming offer and plays the chip cue', () => {
    useStore.getState().patchHand({ handId: 'h-peek' });
    const result = recordOrder(() => {
      handle({
        t: 'peek_offer',
        offerId: 'o1',
        handId: 'h-peek',
        fromUserId: 7,
        fromName: 'Seven',
        targetSeat: 0,
        amount: 25,
      });
    });
    expect(useStore.getState().hand.peekOffers).toEqual([
      { offerId: 'o1', fromUserId: 7, fromName: 'Seven', amount: 25 },
    ]);
    expect(played()).toEqual(['chip']);
    expect(result).toEqual(['write', 'play']);
  });

  it('keeps the existing order when a second offer arrives', () => {
    useStore.getState().patchHand({
      handId: 'h-peek',
      peekOffers: [{ offerId: 'o1', fromUserId: 7, fromName: 'Seven', amount: 25 }],
    });
    handle({
      t: 'peek_offer',
      offerId: 'o2',
      handId: 'h-peek',
      fromUserId: 8,
      fromName: 'Eight',
      targetSeat: 0,
      amount: 50,
    });
    expect(useStore.getState().hand.peekOffers.map((o) => o.offerId)).toEqual(['o1', 'o2']);
  });

  it('ignores a duplicate offer id: no write and no sound', () => {
    useStore.getState().patchHand({
      handId: 'h-peek',
      peekOffers: [{ offerId: 'o1', fromUserId: 7, fromName: 'Seven', amount: 25 }],
    });
    const writes = countWrites(() => {
      handle({
        t: 'peek_offer',
        offerId: 'o1',
        handId: 'h-peek',
        fromUserId: 7,
        fromName: 'Seven',
        targetSeat: 0,
        amount: 25,
      });
    });
    expect(writes).toBe(0);
    expect(played()).toEqual([]);
    expect(useStore.getState().hand.peekOffers).toHaveLength(1);
  });

  it('ignores an offer for a different hand: no write and no sound', () => {
    useStore.getState().patchHand({ handId: 'other' });
    const writes = countWrites(() => {
      handle({
        t: 'peek_offer',
        offerId: 'o1',
        handId: 'h-peek',
        fromUserId: 7,
        fromName: 'Seven',
        targetSeat: 0,
        amount: 25,
      });
    });
    expect(writes).toBe(0);
    expect(played()).toEqual([]);
    expect(useStore.getState().hand.peekOffers).toEqual([]);
  });
});

describe('handEffectsReducer purity', () => {
  it('describes effects as data and plays nothing when called directly', () => {
    useStore.getState().patchHand({ handId: 'h-peek' });
    const result = handEffectsReducer(useStore.getState().hand, {
      t: 'rit_offer',
      handId: 'h-rit',
      deadlineTs: 111,
      voters: [0, 2],
    });
    expect(result).toEqual({
      patch: { ritOffer: { deadlineTs: 111, voters: [0, 2], voted: false } },
      effects: [{ kind: 'sound', name: 'turn' }],
    });
    // The reducer itself is the thing under test here: no sound was executed.
    expect(sounds.play).not.toHaveBeenCalled();
  });

  it('returns null (no patch, no effects) for a duplicate peek_offer', () => {
    useStore.getState().patchHand({
      handId: 'h-peek',
      peekOffers: [{ offerId: 'o1', fromUserId: 7, fromName: 'Seven', amount: 25 }],
    });
    const result = handEffectsReducer(useStore.getState().hand, {
      t: 'peek_offer',
      offerId: 'o1',
      handId: 'h-peek',
      fromUserId: 7,
      fromName: 'Seven',
      targetSeat: 0,
      amount: 25,
    });
    expect(result).toBeNull();
  });
});
