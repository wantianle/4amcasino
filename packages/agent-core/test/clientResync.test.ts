import { describe, expect, it, vi } from 'vitest';
import type { BettingState, CardId, ServerMsg } from '@4am/shared';
import { cardPoint, identityFromSeed, pointHex } from '@4am/mental-poker';
import { HeadlessClient } from '../src/client.js';

/**
 * The reconnect resync barrier lives in `HeadlessClient.handle`: a bare
 * `room_state` does not mean the cached turn is fresh.
 *
 * On the first snapshot after a socket open with `handActive=true`, the stale
 * `betting` snapshot is dropped, so a pre-reconnect `myTurn()` can never be
 * trusted. The server then replays the hand via `Hand.resendPending`, in this
 * order: `hand_start`, the content frames (`your_card`/`board_open`), then the
 * frame for the hand's current phase. The gate (`isResynced`) must NOT open on
 * the bare `hand_start` (it only establishes the hand identity) nor on the
 * content-only replay: a settlement hold still has the board, the private cards
 * and the `showdown` to come, so opening early would read a half-replayed hand.
 * It opens only on a frame that proves the hand's current phase/result - a
 * crypto request frame (`shuffle_turn`/`need_share`), a `multi_run_offer`, an
 * audit `need_keys`, a `betting_state` (while betting), a `showdown`, or a
 * terminal `hand_end`/`hand_abort`. Only a real `betting_state` rebuilds a
 * decidable `betting`; a non-betting frame leaves the table undecidable. A
 * terminal frame also opens the gate (and invalidates betting) so a reconnect
 * that only ever sees the end can never freeze. When the snapshot reports no
 * live hand it is complete on its own and any stale hand is cleared (a missed
 * `hand_end`).
 */

type TestSeams = {
  handle(msg: ServerMsg): void;
  onSocketOpened(): void;
  resyncHandId: string | null;
  endedHands: Set<string>;
  identity: { publicKey: string; secretKey: string };
  handKeys: Map<string, bigint>;
};

const seams = (c: HeadlessClient) => c as unknown as TestSeams;

function roomState(handActive: boolean): ServerMsg {
  return {
    t: 'room_state',
    room: {
      id: 'r1',
      name: 'R',
      joinCode: 'ABCDEF',
      hostId: 1,
      bankerId: 1,
      sb: 10,
      bb: 20,
      auditMode: false,
      actionTimeoutMs: 30_000,
      actionSecs: null,
      coBankerId: null,
      minSettleHands: 0,
      autoApproveBuys: false,
      tvReplays: false,
      autoDeal: false,
      autoDealerId: null,
      commissionBps: 0,
      sevenDeuceBonus: 0,
      voided: false,
    },
    players: [],
    handActive,
    autoDealAt: null,
    autoDealPaused: false,
    readyCheck: null,
  } as unknown as ServerMsg;
}

const BETTING: BettingState = {
  street: 'preflop',
  seats: [
    { seat: 0, stack: 990, committed: 10, total: 10, folded: false, allIn: false, lastActedAt: null },
    { seat: 1, stack: 980, committed: 20, total: 20, folded: false, allIn: false, lastActedAt: null },
  ],
  buttonSeat: 0,
  sb: 10,
  bb: 20,
  currentBet: 20,
  lastRaiseSize: 20,
  lastFullRaiseAt: 20,
  toAct: 0,
  needToAct: [0],
  winnerByFold: null,
};

function bettingState(handId: string, actionSeq: number, toAct: number): ServerMsg {
  return {
    t: 'betting_state',
    handId,
    actionSeq,
    state: { ...BETTING, toAct, needToAct: [toAct] },
    board: [] as CardId[],
    deadline: null,
  } as unknown as ServerMsg;
}

function handStart(handId: string): ServerMsg {
  return {
    t: 'hand_start',
    handId,
    seats: [{ seat: 0, userId: 7, username: 'me' }],
    sb: 10,
    bb: 20,
  } as unknown as ServerMsg;
}

// Non-betting context frames the server replays in the crypto / multirun /
// audit phases. They must satisfy the barrier without rebuilding `betting`.
const shuffleTurn = (handId: string, seat = 0): ServerMsg =>
  ({ t: 'shuffle_turn', handId, seat, deck: [] }) as unknown as ServerMsg;
const needShare = (handId: string, deckIndex = 0): ServerMsg =>
  ({ t: 'need_share', handId, deckIndex, point: '0', purpose: 'hole', forSeat: 0 }) as unknown as ServerMsg;
const yourCard = (handId: string, deckIndex = 0): ServerMsg =>
  ({ t: 'your_card', handId, deckIndex, point: '0' }) as unknown as ServerMsg;
const boardOpen = (handId: string, card: CardId = 0): ServerMsg =>
  ({ t: 'board_open', handId, deckIndex: 5, card }) as unknown as ServerMsg;
const multiRunOffer = (handId: string): ServerMsg =>
  ({
    t: 'multi_run_offer',
    handId,
    decisionId: 'd1',
    stage: 'choice',
    aheadSeat: 0,
    behindSeat: 1,
    equities: [],
    deadlineTs: Date.now() + 1000,
  }) as unknown as ServerMsg;
const needKeys = (handId: string): ServerMsg =>
  ({ t: 'need_keys', handId }) as unknown as ServerMsg;
const handAbort = (handId: string, reason = 'aborted'): ServerMsg =>
  ({ t: 'hand_abort', handId, reason }) as unknown as ServerMsg;
const handEnd = (handId: string): ServerMsg =>
  ({ t: 'hand_end', handId, deltas: [] }) as unknown as ServerMsg;
const showdown = (handId: string): ServerMsg =>
  ({ t: 'showdown', handId, reveals: [], awards: [] }) as unknown as ServerMsg;
const peekOffer = (handId: string, offerId = 'o1'): ServerMsg =>
  ({
    t: 'peek_offer',
    handId,
    offerId,
    fromUserId: 2,
    fromName: 'Villain',
    targetSeat: 0,
    amount: 50,
  }) as unknown as ServerMsg;
const peekResult = (handId: string, offerId = 'o1'): ServerMsg =>
  ({
    t: 'peek_result',
    handId,
    offerId,
    targetSeat: 1,
    status: 'accepted',
    amount: 50,
    cards: [],
  }) as unknown as ServerMsg;
const cardsShown = (handId: string): ServerMsg =>
  ({ t: 'cards_shown', handId, seat: 1, cards: [] }) as unknown as ServerMsg;
const sevenDeuce = (handId: string): ServerMsg =>
  ({ t: 'seven_deuce', handId, seat: 1, amount: 10 }) as unknown as ServerMsg;
const transcriptEntry = (handId: string, type = 'settlement'): ServerMsg =>
  ({ t: 'transcript_entry', handId, seq: 1, type, from: 'srv', head: 'x' }) as unknown as ServerMsg;

/**
 * Establish a stale pre-reconnect turn (our seat, a live betting snapshot), then
 * drop and apply the new epoch's resync snapshot. The stale turn must be gone
 * and the gate closed, awaiting an authoritative context frame.
 */
function staleTurnThenReconnect(): { c: HeadlessClient; s: TestSeams } {
  const { c, s } = freshClient();
  s.handle(roomState(true));
  s.handle(handStart('h1'));
  s.handle(bettingState('h1', 3, 0));
  expect(c.isResynced).toBe(true);
  expect(c.myTurn()).toBe(true);

  s.onSocketOpened();
  s.handle(roomState(true));
  expect(c.isResynced).toBe(false);
  expect(c.betting).toBeNull();
  expect(c.myTurn()).toBe(false);
  return { c, s };
}

/** A client on a fresh socket (new epoch, awaiting its resync frames). */
function freshClient(): { c: HeadlessClient; s: TestSeams } {
  const c = new HeadlessClient('http://127.0.0.1:1', 'unit', 'pw');
  c.userId = 7;
  const s = seams(c);
  s.onSocketOpened(); // connected, new epoch
  return { c, s };
}

describe('HeadlessClient reconnect resync barrier', () => {
  it('keeps the gate closed for a live hand until its authoritative state is replayed', () => {
    const { c, s } = freshClient();
    expect(c.isResynced).toBe(false);

    s.handle(roomState(true));
    // room_state alone is not enough: the cached turn may predate the drop.
    expect(c.isResynced).toBe(false);

    // A stale frame from another hand must not open the gate.
    s.handle(bettingState('other', 3, 0));
    expect(c.isResynced).toBe(false);

    // The replayed `hand_start` only establishes the hand identity: a partial
    // replay (only `hand_start`) is NOT a completed resync.
    s.handle(handStart('h1'));
    expect(c.isResynced).toBe(false);
    expect(c.betting).toBeNull();
    // A phase/terminal frame for this hand completes the resync.
    s.handle(bettingState('h1', 3, 0));
    expect(c.isResynced).toBe(true);
    expect(c.betting).not.toBeNull();
  });

  it('opens the gate immediately when room_state reports no live hand', () => {
    const { c, s } = freshClient();
    s.handle(roomState(false));
    expect(c.isResynced).toBe(true);
  });

  it('does not trust a stale cached turn: the replayed betting_state is authoritative', () => {
    const { c, s } = freshClient();
    // A live hand where it is our turn, observed (and resynced) before the drop.
    s.handle(roomState(true));
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    expect(c.isResynced).toBe(true);
    expect(c.myTurn()).toBe(true);

    // Drop and reconnect: a new epoch. The old `betting` is still cached, but
    // the barrier makes it non-actionable.
    s.onSocketOpened();
    expect(c.isResynced).toBe(false);
    expect(c.myTurn()).toBe(false); // a stale cache never reports a turn

    s.handle(roomState(true));
    expect(c.betting).toBeNull(); // the stale snapshot is cleared on resync
    expect(c.isResynced).toBe(false);
    // The replayed `hand_start` establishes the identity but not the resync...
    s.handle(handStart('h1'));
    expect(c.isResynced).toBe(false);
    // ...the authoritative `betting_state` completes it, and the server has
    // moved on: the replay says seat 1 acts, not us.
    s.handle(bettingState('h1', 5, 1));
    expect(c.isResynced).toBe(true);
    expect(c.myTurn()).toBe(false);
  });

  it('clears a stale hand when a reconnect finds no live hand (missed hand_end)', () => {
    const { c, s } = freshClient();
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    expect(c.handId).toBe('h1');
    expect(c.betting).not.toBeNull();

    // `hand_end` was missed; the reconnected server reports no live hand.
    s.onSocketOpened();
    s.handle(roomState(false));
    expect(c.isResynced).toBe(true);
    expect(c.handId).toBeNull();
    expect(c.betting).toBeNull();
    expect(c.actionSeq).toBe(-1);
    expect(c.myTurn()).toBe(false);
  });

  it('does not re-close the gate when a routine room_state arrives mid-hand', () => {
    const { c, s } = freshClient();
    // The real resync order: room_state -> hand_start -> betting_state.
    s.handle(roomState(true));
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    expect(c.isResynced).toBe(true);
    expect(c.myTurn()).toBe(true);

    // A later broadcast (another join/leave/buy) still reports a live hand; it
    // must not re-arm the barrier and freeze the current turn.
    s.handle(roomState(true));
    expect(c.isResynced).toBe(true);
    expect(c.myTurn()).toBe(true);
  });

  it('re-requires the barrier for every new epoch', () => {
    const { c, s } = freshClient();
    s.handle(roomState(true));
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    expect(c.isResynced).toBe(true);

    s.onSocketOpened();
    expect(c.isResynced).toBe(false);
    s.handle(roomState(true));
    expect(c.isResynced).toBe(false);
  });

  it('does not open the gate on a stale previous-hand context frame', () => {
    const { c, s } = staleTurnThenReconnect();
    s.handle(bettingState('h1-old', 9, 0));
    s.handle(handEnd('h1-old'));
    expect(c.isResynced).toBe(false);

    // The current hand's `hand_start` establishes its identity, but a stale
    // previous-hand terminal frame still cannot open the gate.
    s.handle(handStart('h1'));
    expect(c.isResynced).toBe(false);
    // Only a frame belonging to the current hand may open it.
    s.handle(handEnd('h1'));
    expect(c.isResynced).toBe(true);
  });

  it('opens the gate on a crypto frame but keeps the table undecidable', () => {
    const { c, s } = staleTurnThenReconnect();
    // A bare `hand_start` is a partial replay: the gate stays closed.
    s.handle(handStart('h1'));
    expect(c.isResynced).toBe(false);
    expect(c.betting).toBeNull();

    // The crypto phase frame completes the resync but must not rebuild betting.
    s.handle(shuffleTurn('h1'));
    expect(c.isResynced).toBe(true);
    expect(c.betting).toBeNull();
    expect(c.myTurn()).toBe(false);

    // Only a real betting_state restores decidability.
    s.handle(bettingState('h1', 7, 0));
    expect(c.betting).not.toBeNull();
    expect(c.myTurn()).toBe(true);
  });

  it('opens the gate on a deal/reveal share request without rebuilding betting', () => {
    // `need_share` is a phase marker (the deal is waiting on this seat), so it
    // completes the resync without rebuilding betting.
    const { c, s } = staleTurnThenReconnect();
    s.handle(handStart('h1'));
    expect(c.isResynced).toBe(false);
    s.handle(needShare('h1'));
    expect(c.isResynced).toBe(true);
    expect(c.betting).toBeNull();
    expect(c.myTurn()).toBe(false);
  });

  it('does not open the gate on content-only replay (your_card / board_open)', () => {
    // The server replays content BEFORE the phase frame; a private card or a
    // board card alone is a partial replay and must not open the gate.
    for (const frame of [yourCard('h1'), boardOpen('h1')]) {
      const { c, s } = staleTurnThenReconnect();
      s.handle(handStart('h1'));
      s.handle(frame);
      expect(c.isResynced).toBe(false);
      expect(c.betting).toBeNull();
      expect(c.myTurn()).toBe(false);
    }
  });

  it('does not open the gate on a bare hand_start replay; it only establishes identity', () => {
    const { c, s } = staleTurnThenReconnect();
    s.handle(handStart('h1'));
    expect(s.resyncHandId).toBe('h1');
    expect(c.isResynced).toBe(false);
    expect(c.betting).toBeNull();
    expect(c.myTurn()).toBe(false);
  });

  it('waits for the settlement reveal before declaring a reconnect resynced', () => {
    const { c, s } = staleTurnThenReconnect();
    // A settlement hold replays: hand_start -> content (private cards/board) ->
    // showdown. A partial replay (no reveal yet) must not read as synced.
    s.handle(handStart('h1'));
    s.handle(yourCard('h1'));
    s.handle(boardOpen('h1'));
    expect(c.isResynced).toBe(false);
    // The handId-bound `showdown` proves the hand's result has been replayed.
    s.handle(showdown('h1'));
    expect(c.isResynced).toBe(true);
    expect(c.showdown).not.toBeNull();
    // It leaves the terminal `result` for the later `hand_end`.
    expect(c.result).toBeNull();
    expect(c.betting).toBeNull();
    expect(c.myTurn()).toBe(false);
  });

  it('waits for hand_end when the settlement replays without a showdown', () => {
    const { c, s } = staleTurnThenReconnect();
    s.handle(handStart('h1'));
    s.handle(yourCard('h1'));
    expect(c.isResynced).toBe(false);
    // A quiet/fold win replays no showdown; the terminal frame is what settles it.
    s.handle(handEnd('h1'));
    expect(c.isResynced).toBe(true);
    expect(c.result).not.toBeNull();
    expect(c.myTurn()).toBe(false);
  });

  it('does not open the gate on a showdown bound to a different hand', () => {
    const { c, s } = staleTurnThenReconnect();
    s.handle(handStart('h1'));
    s.handle(showdown('h-old'));
    expect(c.isResynced).toBe(false);
    expect(c.showdown).toBeNull();
    // Only the hand being resynced may complete it.
    s.handle(showdown('h1'));
    expect(c.isResynced).toBe(true);
  });

  it('opens the gate on a multirun offer and an audit need_keys', () => {
    {
      const { c, s } = staleTurnThenReconnect();
      s.handle(handStart('h1'));
      expect(c.isResynced).toBe(false); // hand_start alone is partial
      s.handle(multiRunOffer('h1'));
      expect(c.isResynced).toBe(true);
      expect(c.betting).toBeNull();
      expect(c.myTurn()).toBe(false);
    }
    {
      const { c, s } = staleTurnThenReconnect();
      s.handle(handStart('h1'));
      expect(c.isResynced).toBe(false);
      s.handle(needKeys('h1'));
      expect(c.isResynced).toBe(true);
      expect(c.betting).toBeNull();
      expect(c.myTurn()).toBe(false);
    }
  });

  it('opens the gate on a terminal frame and never freezes when the hand ends with no new hand', () => {
    for (const frame of [handAbort('h1'), handEnd('h1')]) {
      const { c, s } = staleTurnThenReconnect();
      s.handle(handStart('h1'));
      expect(c.isResynced).toBe(false); // hand_start alone is partial
      s.handle(frame);
      expect(c.isResynced).toBe(true);
      expect(c.betting).toBeNull();
      expect(c.myTurn()).toBe(false);
      // A later routine room_state must not re-close the gate (no permanent freeze).
      for (let i = 0; i < 3; i++) {
        s.handle(roomState(true));
        expect(c.isResynced).toBe(true);
      }
    }
  });

  it('leaves the normal (non-reconnect) path unchanged', () => {
    const { c, s } = freshClient();
    s.handle(roomState(true)); // resync snapshot: no stale betting to clear
    s.handle(handStart('h1'));
    s.handle(shuffleTurn('h1')); // a crypto frame opens the gate
    expect(c.isResynced).toBe(true);
    s.handle(bettingState('h1', 0, 0));
    expect(c.betting).not.toBeNull();
    expect(c.myTurn()).toBe(true);
  });

  it('ignores a stale betting_state without mutating any cached state', () => {
    const { c, s } = staleTurnThenReconnect();
    s.handle(handStart('h1'));
    // Seed non-default cached values so a stale write would be visible.
    c.board = [5 as CardId];
    c.deadline = 999;
    const actionSeq = c.actionSeq;

    s.handle(bettingState('h-old', 42, 1));

    expect(c.betting).toBeNull();
    expect(c.actionSeq).toBe(actionSeq);
    expect(c.board).toEqual([5]);
    expect(c.deadline).toBe(999);
  });

  it('ignores a stale hand_end (no result, no terminal state)', () => {
    const { c, s } = staleTurnThenReconnect();
    s.handle(handStart('h1'));
    s.handle(handEnd('h-old'));
    expect(c.result).toBeNull();
  });

  it('ignores a stale hand_abort', () => {
    const { c, s } = staleTurnThenReconnect();
    s.handle(handStart('h1'));
    s.handle(handAbort('h-old'));
    expect(c.abort).toBeNull();
  });

  it('ignores stale board_open and showdown frames', () => {
    const { c, s } = staleTurnThenReconnect();
    s.handle(handStart('h1'));
    const board = [...c.board];

    s.handle(boardOpen('h-old', 42));
    expect(c.board).toEqual(board);

    s.handle(showdown('h-old'));
    expect(c.showdown).toBeNull();
  });

  it('does not resurrect stale betting on a same-handId hand_start after resync', () => {
    const { c, s } = staleTurnThenReconnect();
    // A stale frame from the SAME hand id arrives before the replay: it must be
    // ignored because the resync hand has not been established yet.
    s.handle(bettingState('h1', 9, 0));
    expect(c.betting).toBeNull();

    // The legitimate replay establishes identity, but must not rebuild the old
    // betting snapshot and does not open the gate on its own.
    s.handle(handStart('h1'));
    expect(c.isResynced).toBe(false);
    expect(c.betting).toBeNull();
    expect(c.myTurn()).toBe(false);

    // Only a real, post-resync betting_state opens the gate and restores betting.
    s.handle(bettingState('h1', 7, 0));
    expect(c.isResynced).toBe(true);
    expect(c.betting).not.toBeNull();
    expect(c.myTurn()).toBe(true);
  });

  it('establishes the next hand even when the previous hand_end was missed', () => {
    const { c, s } = freshClient();
    s.handle(roomState(true));
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    expect(c.handId).toBe('h1');

    // Drop/reconnect: the resync reports no live hand (we missed `hand_end`).
    s.onSocketOpened();
    s.handle(roomState(false));
    expect(c.isResynced).toBe(true);

    // The next hand's `hand_start` must still establish context despite the
    // cleared/old hand id.
    s.handle(handStart('h2'));
    expect(c.handId).toBe('h2');
    expect(c.isResynced).toBe(true);
  });

  it('does not freeze on done -> reconnect -> no-hand snapshot', () => {
    const { c, s } = freshClient();
    s.handle(roomState(true));
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    s.handle(handEnd('h1'));
    expect(c.result).not.toBeNull();
    expect(c.isResynced).toBe(true);

    s.onSocketOpened();
    s.handle(roomState(false)); // the hand is gone
    expect(c.connected).toBe(true);
    expect(c.isResynced).toBe(true);
  });

  it('drops a stale peek_offer and never answers it', () => {
    const { c, s } = staleTurnThenReconnect(); // holds hand h1
    const send = vi.spyOn(c, 'send');
    s.handle(peekOffer('h-old', 'o-old'));
    expect(c.peekOffers).toEqual([]);
    // A stale offer triggers no automatic answer, and answering the dropped id
    // must not emit any frame either.
    expect(send).not.toHaveBeenCalled();
    c.answerPeek('o-old', true);
    expect(send).not.toHaveBeenCalled();
  });

  it('auto-accepts a peek_offer for the recent hand with shares and a signature', () => {
    const { c, s } = freshClient();
    s.identity = identityFromSeed(new Uint8Array(32).fill(7));
    s.handle(roomState(true));
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    s.handle(handEnd('h1')); // recent hand is h1
    s.handKeys.set('h1', 123456789n);
    c.myCardPoints = [
      { deckIndex: 0, point: pointHex(cardPoint(0)) },
      { deckIndex: 1, point: pointHex(cardPoint(1)) },
    ];
    c.myCardPointsHandId = 'h1';

    const send = vi.spyOn(c, 'send');
    s.handle(peekOffer('h1', 'o1'));
    // No manual answer: the bot agrees on its own.
    expect(send).toHaveBeenCalledTimes(1);
    const frame = send.mock.calls[0]![0] as Record<string, unknown>;
    expect(frame).toMatchObject({ t: 'peek_accept', handId: 'h1', offerId: 'o1' });
    expect((frame.shares as unknown[]).length).toBe(2);
    expect(typeof frame.sig).toBe('string');
    expect(c.peekOffers).toEqual([]);
  });

  it('declines a peek instead of minting a key for a hand it did not play', () => {
    const { c, s } = freshClient();
    s.identity = identityFromSeed(new Uint8Array(32).fill(7));
    s.handle(roomState(true));
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    s.handle(handEnd('h1'));
    // Points from the ended hand, but the per-hand key was already cleared (a
    // new hand_start drops every key except the current one). Answering must
    // decline, never implicitly mint a fresh key and sign bogus shares.
    c.myCardPoints = [
      { deckIndex: 0, point: pointHex(cardPoint(0)) },
      { deckIndex: 1, point: pointHex(cardPoint(1)) },
    ];
    c.myCardPointsHandId = 'h1';
    s.handKeys.delete('h1');

    const send = vi.spyOn(c, 'send');
    s.handle(peekOffer('h1', 'o1'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      t: 'peek_decline',
      handId: 'h1',
      offerId: 'o1',
    });
    expect(c.peekOffers).toEqual([]);
  });

  it('auto-declines a peek_offer when it has no cards to reveal', () => {
    const { c, s } = freshClient();
    s.identity = identityFromSeed(new Uint8Array(32).fill(7));
    s.handle(roomState(true));
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    s.handle(handEnd('h1'));

    const send = vi.spyOn(c, 'send');
    s.handle(peekOffer('h1', 'o1'));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ t: 'peek_decline', offerId: 'o1' }),
    );
    expect(c.peekOffers).toEqual([]);
  });

  it('does not record a transcript entry for an unrelated hand', () => {
    const { s } = staleTurnThenReconnect(); // holds hand h1
    s.handle(transcriptEntry('h-old', 'settlement'));
    expect(s.endedHands.has('h-old')).toBe(false);

    s.handle(transcriptEntry('h1', 'settlement'));
    expect(s.endedHands.has('h1')).toBe(true);
  });

  it('ignores stale cards_shown / seven_deuce / peek_result frames', () => {
    const { c, s } = staleTurnThenReconnect(); // holds hand h1
    const eventsBefore = c.events.length;
    s.handle(cardsShown('h-old'));
    s.handle(sevenDeuce('h-old'));
    s.handle(peekResult('h-old'));
    expect(c.events.length).toBe(eventsBefore);
  });

  it('clears resyncHandId on a no-live-hand snapshot even with a kept terminal result', () => {
    const { c, s } = freshClient();
    s.handle(roomState(true));
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    expect(s.resyncHandId).toBe('h1');

    s.handle(handEnd('h1')); // terminal result is kept
    expect(c.result).not.toBeNull();

    s.onSocketOpened();
    s.handle(roomState(false));
    expect(s.resyncHandId).toBeNull();
    expect(c.isResynced).toBe(true);
  });

  it('clears resyncHandId on a routine no-hand room_state after settlement', () => {
    const { c, s } = freshClient();
    s.handle(roomState(true)); // consumes the reconnect flag
    s.handle(handStart('h1'));
    s.handle(bettingState('h1', 3, 0));
    expect(s.resyncHandId).toBe('h1');

    s.handle(handEnd('h1'));
    expect(c.result).not.toBeNull();
    expect(s.resyncHandId).toBe('h1'); // still set until a snapshot says no hand

    // A ROUTINE (non-reconnect) room_state reporting no hand.
    s.handle(roomState(false));
    expect(s.resyncHandId).toBeNull();
    expect(c.result).not.toBeNull(); // terminal result kept for recordHandEnd
    expect(c.isResynced).toBe(true);
  });

  it('replies to need_keys for the current hand even without a settlement transcript', () => {
    const { c, s } = freshClient();
    s.identity = identityFromSeed(new Uint8Array(32));
    s.handle(roomState(true));
    s.handle(handStart('h1')); // establishes identity and derives the hand key
    // A reconnecting client is never replayed the settlement transcript.
    expect(s.endedHands.has('h1')).toBe(false);
    expect(s.handKeys.has('h1')).toBe(true);

    const send = vi.spyOn(c, 'send');
    s.handle(needKeys('h1'));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ t: 'reveal_key', handId: 'h1' }),
    );
  });

  it('ignores need_keys for a hand that is not the current one', () => {
    const { c, s } = freshClient();
    s.identity = identityFromSeed(new Uint8Array(32));
    s.handle(roomState(true));
    s.handle(handStart('h1'));

    const send = vi.spyOn(c, 'send');
    s.handle(needKeys('h-other'));
    expect(send).not.toHaveBeenCalled();
  });
});
