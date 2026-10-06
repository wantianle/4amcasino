import { beforeEach, describe, expect, it, vi } from 'vitest';
import { genIdentity } from '@4am/mental-poker';
import type { ServerMsg } from '@4am/shared';

/**
 * Skeleton coverage for `gameClient.handle()` gaps not already exercised by the
 * existing suite. This file deliberately mirrors the mock/injection style of
 * `settlementFailure.test.ts` (hoisted `ws` double + direct `handle` calls), and
 * only fills the holes:
 *
 *   - duplicate `board_open` (metadata once, no second deal-motion epoch)
 *   - a stale `hand_end` for an older hand must not populate the current recap
 *   - `run_count_choice` / `run_count_agree` for both stages + stage guards
 *   - `hand_recovery` for an unrelated hand is ignored
 *   - `room_state(handActive:false)` WITHOUT a resync is not a restart
 *   - switching rooms is a session boundary
 *
 * Already covered elsewhere, so intentionally NOT repeated here:
 *   - `settlement_failed` + host retry lifecycle  -> settlementFailure.test.ts
 *   - `hand_recovery` committed/aborted/unresolved -> settlementFailure.test.ts,
 *     handRecoveryReconnect.test.ts
 *   - resync-with-failure / synthesised refund abort -> settlementFailure.test.ts
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
const { handle, chooseRunCount, agreeRunCount, dealMotionEpoch, boardMotionKey, __resetHandTrackingForTest } =
  await import('../src/shared/gameClient.ts');

let handNumber = 0;

function signIn(userId = 1): void {
  useStore.setState({
    auth: { token: 't', userId, username: 'me', identity: genIdentity() },
    wsConnected: true,
  });
}

const roomState = (handActive = true): Extract<ServerMsg, { t: 'room_state' }> => ({
  t: 'room_state',
  room: {
    id: 'r',
    name: 'r',
    joinCode: 'ABC',
    hostId: 1,
    bankerId: 1,
    sb: 10,
    bb: 20,
    auditMode: 'private',
    actionTimeoutMs: 45_000,
    actionSecs: 45,
    coBankerId: null,
    minSettleHands: 0,
    sevenDeuceBonus: 0,
    voided: false,
    autoApproveBuys: false,
    tvReplays: false,
    commissionBps: 0,
  },
  players: [],
  handActive,
});

const handStart = (handId: string): ServerMsg => ({
  t: 'hand_start',
  handId,
  seats: [{ seat: 0, userId: 1, username: 'me', publicKey: '', stack: 1000 }],
  buttonSeat: 0,
  sb: 10,
  bb: 20,
  auditMode: 'private',
});

type MultiRunOffer = Extract<ServerMsg, { t: 'multi_run_offer' }>;
const offer = (
  stage: MultiRunOffer['stage'],
  extra: Partial<MultiRunOffer> = {},
): MultiRunOffer => ({
  t: 'multi_run_offer',
  handId: 'run-hand',
  decisionId: 'd1',
  stage,
  aheadSeat: 0,
  behindSeat: 1,
  equities: [],
  deadlineTs: 999,
  ...extra,
});

beforeEach(() => {
  socket.send.mockClear();
  socket.consumeResync.mockReset();
  socket.consumeResync.mockReturnValue(false);
  __resetHandTrackingForTest();
  useStore.getState().resetHand();
  signIn(1);
});

describe('gameClient board_open', () => {
  it('a duplicate board_open adds the card once and does not re-advance the deal epoch', () => {
    const handId = `board-dup-${handNumber++}`;
    useStore.getState().patchHand({ handId });
    const cardKey = boardMotionKey(handId, 0, 7);

    handle({ t: 'board_open', handId, deckIndex: 4, card: 7 });
    const firstEpoch = dealMotionEpoch(handId, cardKey);
    expect(firstEpoch).toBeGreaterThan(0);
    expect(useStore.getState().hand.boards).toEqual([[7]]);

    // the server replays the frame on reconnect: metadata is idempotent and the
    // card must not fly a second time
    handle({ t: 'board_open', handId, deckIndex: 4, card: 7 });
    expect(useStore.getState().hand.boards).toEqual([[7]]);
    expect(dealMotionEpoch(handId, cardKey)).toBe(firstEpoch);
  });

  it('ignores a board_open for a hand the client is no longer holding', () => {
    const handId = `board-ignore-${handNumber++}`;
    useStore.getState().patchHand({ handId, boards: [[1, 2, 3]] });
    handle({ t: 'board_open', handId: 'a-stale-hand', deckIndex: 9, card: 40 });
    expect(useStore.getState().hand.boards).toEqual([[1, 2, 3]]);
  });
});

describe('gameClient stale terminal frames', () => {
  it('a late hand_end for an older hand does not populate the current result or recap', () => {
    useStore.getState().patchHand({ handId: 'current-hand' });
    handle({ t: 'hand_end', handId: 'old-hand', head: 'old-head', stacks: [], deltas: [] });
    const h = useStore.getState().hand;
    expect(h.handId).toBe('current-hand');
    expect(h.result).toBeNull();
    expect(useStore.getState().lastHand).toBeNull();
  });
});

describe('gameClient multi-run negotiation', () => {
  it('chooseRunCount at the choice stage records the pick optimistically and signs the reply', () => {
    useStore.getState().patchHand({ handId: 'run-hand' });
    handle(offer('choice'));
    chooseRunCount(2);

    const sent = socket.send.mock.calls.map(([m]) => m) as { t: string; sig?: string }[];
    expect(sent.at(-1)).toMatchObject({
      t: 'run_count_choice',
      handId: 'run-hand',
      decisionId: 'd1',
      count: 2,
    });
    expect(typeof sent.at(-1)!.sig).toBe('string');
    expect(useStore.getState().hand.multiRunOffer?.requestedRuns).toBe(2);
  });

  it('chooseRunCount is a no-op outside the choice stage', () => {
    useStore.getState().patchHand({ handId: 'run-hand' });
    handle(offer('agreement', { requestedRuns: 2 }));
    const before = socket.send.mock.calls.length;
    chooseRunCount(3);
    expect(socket.send.mock.calls.length).toBe(before);
  });

  it('agreeRunCount at the agreement stage signs the decision', () => {
    useStore.getState().patchHand({ handId: 'run-hand' });
    handle(offer('agreement', { requestedRuns: 2 }));
    agreeRunCount(true);
    expect(socket.send.mock.calls.at(-1)![0]).toMatchObject({
      t: 'run_count_agree',
      handId: 'run-hand',
      decisionId: 'd1',
      agree: true,
    });
  });

  it('agreeRunCount is a no-op outside the agreement stage', () => {
    useStore.getState().patchHand({ handId: 'run-hand' });
    handle(offer('choice'));
    const before = socket.send.mock.calls.length;
    agreeRunCount(false);
    expect(socket.send.mock.calls.length).toBe(before);
  });
});

describe('gameClient room_state without a live hand', () => {
  it('does not synthesise a refund abort when this frame is not a resync', () => {
    useStore.getState().patchHand({ handId: 'live-hand' });
    socket.consumeResync.mockReturnValue(false);
    handle(roomState(false));
    const h = useStore.getState().hand;
    expect(h.handId).toBe('live-hand');
    expect(h.abort).toBeNull();
    expect(h.result).toBeNull();
  });
});

describe('gameClient recovery for an unrelated hand', () => {
  it('ignores a hand_recovery answer that names a different hand', () => {
    useStore.getState().patchHand({ handId: 'mine' });
    handle({ t: 'hand_recovery', handId: 'theirs', status: 'unresolved' });
    const h = useStore.getState().hand;
    expect(h.handRecovery).toBeNull();
    expect(h.result).toBeNull();
    expect(h.abort).toBeNull();
  });
});

describe('gameClient session boundary', () => {
  it('switching rooms drops the old hand, recap and recovery state', () => {
    // Room A: holding a hand the server left unresolved, with a recap on screen.
    useStore.getState().patchHand({
      handId: 'A-hand',
      handRecovery: 'unresolved',
      boards: [[1, 2, 3]],
      result: null,
      settlementFailed: {
        handId: 'A-hand',
        reason: 'SQLITE_BUSY',
        attempt: 1,
        retrying: false,
        retryRequestedAt: null,
        manualRetry: false,
        since: 1,
        orphaned: true,
      },
    });
    expect(useStore.getState().hand.handRecovery).toBe('unresolved');

    // Exactly what the room effect does on leave.
    useStore.getState().resetHand();

    // Room B's first hand cannot resurrect Room A's state.
    handle(handStart('B-hand'));
    const h = useStore.getState().hand;
    expect(h.handId).toBe('B-hand');
    expect(h.handRecovery).toBeNull();
    expect(h.boards).toEqual([]);
    expect(h.result).toBeNull();
    expect(h.abort).toBeNull();
    expect(h.settlementFailed).toBeNull();
  });
});
