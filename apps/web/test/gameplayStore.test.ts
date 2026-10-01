import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
const { useStore } = await import('../src/shared/store.ts');

beforeEach(() => useStore.getState().resetHand());

describe('boards -> board/board2 migration adapter', () => {
  it('derives the legacy board/board2 fields from canonical boards', () => {
    useStore.getState().patchHand({ boards: [[0, 1, 2], [3, 4]] });
    const h = useStore.getState().hand;
    expect(h.boards).toEqual([[0, 1, 2], [3, 4]]);
    expect(h.board).toEqual([0, 1, 2]);
    expect(h.board2).toEqual([3, 4]);
  });

  it('folds legacy board/board2 writes back into boards', () => {
    useStore.getState().patchHand({ board: [7] });
    useStore.getState().patchHand({ board2: [8] });
    const h = useStore.getState().hand;
    expect(h.boards[0]).toEqual([7]);
    expect(h.boards[1]).toEqual([8]);
    expect(h.board).toEqual([7]);
    expect(h.board2).toEqual([8]);
  });

  it('clears every new-gameplay field on reset', () => {
    useStore.getState().patchHand({
      boards: [[0], [1]],
      baseDeadline: 123,
      timeBanks: { 1: 30_000 },
      featureStarted: { squid: { enabled: true, penaltyBb: 2, minPlayers: 2 } },
      multiRunOffer: {
        t: 'multi_run_offer',
        handId: 'h1',
        decisionId: 'd1',
        stage: 'choice',
        aheadSeat: 0,
        behindSeat: 1,
        equities: [],
        deadlineTs: 999,
      },
      multiRunResult: { t: 'multi_run_result', handId: 'h1', runs: 2, reason: 'agreed', sharedBoard: [] },
      squidResult: {
        t: 'squid_result',
        handId: 'h1',
        winners: [],
        transfers: [],
        requestedPerLoser: 0,
        paidBySeat: [],
        noClaimant: true,
      },
    });
    useStore.getState().resetHand();
    const h = useStore.getState().hand;
    expect(h.boards).toEqual([]);
    expect(h.board).toEqual([]);
    expect(h.board2).toEqual([]);
    expect(h.baseDeadline).toBeNull();
    expect(h.timeBanks).toEqual({});
    expect(h.featureStarted).toBeNull();
    expect(h.multiRunOffer).toBeNull();
    expect(h.multiRunResult).toBeNull();
    expect(h.squidResult).toBeNull();
  });
});

describe('base deadline + time banks', () => {
  it('stores the street base deadline and per-seat balances', () => {
    useStore.getState().patchHand({ baseDeadline: 5_000, timeBanks: { 1: 30_000, 4: 12_500 } });
    const h = useStore.getState().hand;
    expect(h.baseDeadline).toBe(5_000);
    expect(h.timeBanks).toEqual({ 1: 30_000, 4: 12_500 });
  });
});
