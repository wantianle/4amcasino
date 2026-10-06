import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '@4am/shared';

/**
 * Behaviour lock for the `handReducer` extraction.
 *
 * Every case below is driven through the PUBLIC entry point (`handle`), exactly
 * the way the pre-extraction switch was. The snapshots these assertions encode
 * were captured from the original code and are byte-for-byte identical after
 * the extraction (see the parity run in the lane report), so this file guards
 * the reducer-routed frames against future drift.
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
});
