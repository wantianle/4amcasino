import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '@4am/shared';

/**
 * Behaviour lock for the `handReducer` extraction.
 *
 * Every case below is driven through the PUBLIC entry point (`handle`), exactly
 * the way the pre-extraction switch was. These are **representative result
 * assertions** over that public path - they are NOT a byte-for-byte snapshot
 * diff against the original implementation, and no old/new double-execution
 * harness backs them. The extraction was reviewed by comparing the two code
 * paths by hand, not by capturing snapshots. These assertions lock the
 * observable `(input frame -> store result)` contract so the reducer-routed
 * frames cannot drift unnoticed.
 */

const socket = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(),
  consumeResync: vi.fn(() => false),
}));
vi.mock('../src/shared/ws.ts', () => ({ wsClient: socket }));
vi.mock('../src/shared/voice.ts', () => ({ voice: { syncPeers: vi.fn(), handleRtc: vi.fn() } }));
vi.mock('../src/shared/sounds.ts', () => ({ play: vi.fn() }));
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

const NOW = 1_700_000_000_000;

/** Runs `fn` while counting store notifications, then unsubscribes. A frame
 *  that early-returns without calling `patchHand` produces zero notifications,
 *  which distinguishes it from a write of an identical value. */
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

const squid = { enabled: true, penaltyBb: 1, minPlayers: 2 };
const bombPot = { enabled: false, anteBb: 1 as const, schedule: { mode: 'hands' as const, value: 10 } };

beforeEach(() => {
  socket.send.mockClear();
  socket.consumeResync.mockReset();
  socket.consumeResync.mockReturnValue(false);
  __resetHandTrackingForTest();
  useStore.getState().resetHand();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('handReducer parity: ready_end', () => {
  it('clears the ready check and leaves everything else untouched', () => {
    useStore.getState().patchHand({
      handId: 'h-ready',
      readyCheck: { deadlineTs: 1, eligible: [0, 1], ready: [0] },
      autoDealAt: NOW + 5000,
    });
    handle({ t: 'ready_end' });
    const h = useStore.getState().hand;
    expect(h.readyCheck).toBeNull();
    expect(h.handId).toBe('h-ready');
    expect(h.autoDealAt).toBe(NOW + 5000);
  });

  it('applies on both of two repeated frames (two writes, same result)', () => {
    useStore.getState().patchHand({
      handId: 'h-ready',
      readyCheck: { deadlineTs: 1, eligible: [0, 1], ready: [0] },
    });
    const before = useStore.getState().hand;
    handle({ t: 'ready_end' });
    const afterFirst = useStore.getState().hand;
    handle({ t: 'ready_end' });
    const afterSecond = useStore.getState().hand;
    // each frame patches the store, so the hand object identity changes twice
    // (a no-op early-return would leave `afterSecond === afterFirst`)
    expect(afterFirst).not.toBe(before);
    expect(afterSecond).not.toBe(afterFirst);
    expect(afterFirst.readyCheck).toBeNull();
    expect(afterSecond.readyCheck).toBeNull();
  });
});

describe('handReducer parity: feature_started', () => {
  it('applies when handId matches', () => {
    useStore.getState().patchHand({ handId: 'h-feat' });
    handle({ t: 'feature_started', handId: 'h-feat', squid, bombPot });
    expect(useStore.getState().hand.featureStarted).toEqual({ squid, bombPot });
  });

  it('applies when handId is absent', () => {
    useStore.getState().patchHand({ handId: 'h-feat' });
    handle({ t: 'feature_started', squid, bombPot });
    expect(useStore.getState().hand.featureStarted).toEqual({ squid, bombPot });
  });

  it('applies when handId is the empty string (treated as "no hand")', () => {
    useStore.getState().patchHand({ handId: 'h-feat', featureStarted: null });
    handle({ t: 'feature_started', handId: '', squid, bombPot });
    expect(useStore.getState().hand.featureStarted).toEqual({ squid, bombPot });
  });

  it('writes the store when handId equals the current hand', () => {
    useStore.getState().patchHand({ handId: 'h-feat', featureStarted: null });
    const writes = countWrites(() => {
      handle({ t: 'feature_started', handId: 'h-feat', squid, bombPot });
    });
    expect(writes).toBe(1);
  });

  it('does not write the store at all when handId is stale', () => {
    useStore.getState().patchHand({ handId: 'h-feat', featureStarted: { squid, bombPot } });
    const writes = countWrites(() => {
      handle({ t: 'feature_started', handId: 'other', squid: undefined, bombPot: undefined });
    });
    // zero writes: the reducer returned null, so `patchHand` was never called.
    // A write-of-the-same-value would have produced 1.
    expect(writes).toBe(0);
    expect(useStore.getState().hand.featureStarted).toEqual({ squid, bombPot });
  });

  it('is ignored for a different hand (no store write)', () => {
    useStore.getState().patchHand({ handId: 'h-feat', featureStarted: { squid, bombPot } });
    handle({ t: 'feature_started', handId: 'other', squid: undefined, bombPot: undefined });
    expect(useStore.getState().hand.featureStarted).toEqual({ squid, bombPot });
  });
});

describe('handReducer parity: time_bank_update', () => {
  it('merges the seat balance into the keyed map', () => {
    useStore.getState().patchHand({ handId: 'h-tb', timeBanks: { 0: 100 } });
    handle({ t: 'time_bank_update', handId: 'h-tb', seat: 1, remainingMs: 250 });
    expect(useStore.getState().hand.timeBanks).toEqual({ 0: 100, 1: 250 });
  });

  it('overwrites an existing seat balance', () => {
    useStore.getState().patchHand({ handId: 'h-tb', timeBanks: { 0: 100 } });
    handle({ t: 'time_bank_update', handId: 'h-tb', seat: 0, remainingMs: 5 });
    expect(useStore.getState().hand.timeBanks).toEqual({ 0: 5 });
  });

  it('produces a fresh map with only the current seat when the map is empty', () => {
    useStore.getState().patchHand({ handId: 'h-tb', timeBanks: {} });
    const before = useStore.getState().hand.timeBanks;
    handle({ t: 'time_bank_update', handId: 'h-tb', seat: 2, remainingMs: 300 });
    const after = useStore.getState().hand.timeBanks;
    expect(after).toEqual({ 2: 300 });
    expect(after).not.toBe(before); // merge, not in-place mutation
    expect(before).toEqual({}); // the previous map is untouched
  });
});

describe('handReducer parity: peek_offers_snapshot', () => {
  it('keeps only the listed incoming offers, in order', () => {
    useStore.getState().patchHand({
      handId: 'h-peek',
      peekOffers: [
        { offerId: 'a', fromUserId: 2, fromName: 'A', amount: 10 },
        { offerId: 'b', fromUserId: 3, fromName: 'B', amount: 20 },
      ],
    });
    handle({ t: 'peek_offers_snapshot', incomingOfferIds: ['a', 'c'] });
    expect(useStore.getState().hand.peekOffers.map((o) => o.offerId)).toEqual(['a']);
  });

  it('clears all offers on an empty snapshot', () => {
    useStore.getState().patchHand({
      handId: 'h-peek',
      peekOffers: [{ offerId: 'a', fromUserId: 2, fromName: 'A', amount: 10 }],
    });
    handle({ t: 'peek_offers_snapshot', incomingOfferIds: [] });
    expect(useStore.getState().hand.peekOffers).toEqual([]);
  });

  it('still yields a new array when the existing list is already empty', () => {
    useStore.getState().patchHand({ handId: 'h-peek', peekOffers: [] });
    const before = useStore.getState().hand.peekOffers;
    handle({ t: 'peek_offers_snapshot', incomingOfferIds: [] });
    const after = useStore.getState().hand.peekOffers;
    // "always a fresh array" is a locked property: even an empty->empty snapshot
    // replaces the reference (identity changes, value stays [])
    expect(after).toEqual([]);
    expect(after).not.toBe(before);
  });
});

describe('handReducer parity: auto_deal', () => {
  it('sets an absolute deadline from the relative delay', () => {
    handle({ t: 'auto_deal', inMs: 5000 });
    expect(useStore.getState().hand.autoDealAt).toBe(NOW + 5000);
  });

  it('clears the deadline when inMs is not positive', () => {
    useStore.getState().patchHand({ autoDealAt: NOW });
    handle({ t: 'auto_deal', inMs: 0 });
    expect(useStore.getState().hand.autoDealAt).toBeNull();
  });

  it.each([
    ['negative', -1],
    ['zero', 0],
    ['undefined', undefined],
    ['NaN', Number.NaN],
  ])('clears the deadline when inMs is %s', (_label, inMs) => {
    useStore.getState().patchHand({ autoDealAt: NOW + 1 });
    handle({ t: 'auto_deal', inMs } as unknown as ServerMsg);
    expect(useStore.getState().hand.autoDealAt).toBeNull();
  });

  it('treats Infinity as a positive delay (deadline becomes Infinity)', () => {
    handle({ t: 'auto_deal', inMs: Number.POSITIVE_INFINITY });
    expect(useStore.getState().hand.autoDealAt).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps a very large finite delay finite and greater than now', () => {
    const huge = Number.MAX_SAFE_INTEGER;
    handle({ t: 'auto_deal', inMs: huge });
    const at = useStore.getState().hand.autoDealAt;
    expect(typeof at).toBe('number');
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThan(NOW);
    expect(at).toBe(NOW + huge);
  });
});

describe('handReducer parity: clock reads', () => {
  it('reads Date.now only for auto_deal, never for the other four frames', () => {
    vi.mocked(Date.now).mockClear();
    handle({ t: 'ready_end' });
    handle({ t: 'feature_started', handId: 'h', squid, bombPot });
    handle({ t: 'time_bank_update', handId: 'h', seat: 0, remainingMs: 1 });
    handle({ t: 'peek_offers_snapshot', incomingOfferIds: [] });
    expect(vi.mocked(Date.now)).toHaveBeenCalledTimes(0);

    handle({ t: 'auto_deal', inMs: 5000 });
    expect(vi.mocked(Date.now)).toHaveBeenCalledTimes(1);
    expect(useStore.getState().hand.autoDealAt).toBe(NOW + 5000);
  });
});
