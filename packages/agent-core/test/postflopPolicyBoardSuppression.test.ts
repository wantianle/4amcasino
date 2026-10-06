import { describe, expect, it } from 'vitest';
import { cardFromName, type CardId } from '@4am/shared';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionPotOdds,
  DecisionSeat,
  DecisionView,
} from '../src/decisionView.js';
import { PostflopPolicy, classifyTexture, evaluateHand, madeHandSuppressedByBoard } from '../src/postflopPolicy.js';
import { RULE_PRESETS } from '../src/ruleStyles.js';

const c = (n: string) => cardFromName(n);
const SEED = 7;

/** Rules-v1 facing-bet policy, fixed seed so the frequency RNG is deterministic. */
const policy = () =>
  new PostflopPolicy({ params: RULE_PRESETS['tight-aggressive'], seed: SEED });

// ---------------------------------------------------------------------------
// view builder (mirrors the P0/P1 facing-bet fixture)
// ---------------------------------------------------------------------------

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 0,
    userId: 2,
    displayName: 'villain',
    isMe: false,
    stack: 1000,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    ...over,
  };
}

/** Facing a bet of `call` into a total pot of `pot` (pot includes the bet). */
function facingView(
  hole: CardId[],
  board: CardId[],
  pot: number,
  call: number,
  seq: number,
): DecisionView {
  const villain = seat({ seat: 0, committed: call, total: call });
  const me: DecisionSeat = {
    seat: 1,
    userId: 1,
    displayName: 'hero',
    isMe: true,
    stack: 1000,
    committed: call,
    total: call,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
  };
  const hand: DecisionHand = {
    handId: 'h1',
    street: board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : 'flop',
    buttonSeat: 1,
    board,
    pot,
    currentBet: call,
    toAct: 1,
    deadline: null,
    myCards: hole,
    mySeat: 1,
  };
  const legal: DecisionLegalActions = {
    canCheck: false,
    canCall: true,
    callAmount: call,
    canBet: false,
    canRaise: true,
    minRaiseTo: call * 2,
    maxRaiseTo: 1000,
  };
  const potOdds: DecisionPotOdds = {
    callAmount: call,
    pot,
    potOdds: call / (pot + call),
    breakEvenEquity: call / (pot + call),
  };
  return {
    room: { id: 'r', name: 'r', sb: 1, bb: 2, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand,
    me,
    legalActions: legal,
    potOdds,
    actionHistory: [],
    opponents: [villain],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder: [0, 1],
    actionSeq: seq,
  };
}

/**
 * Unopened (checked-to) view: hero can check or bet into a total pot of `pot`.
 * Mirrors the unopened branch (`la.canCheck`) rather than the facing-bet one.
 */
function unopenedView(hole: CardId[], board: CardId[], pot: number, seq: number): DecisionView {
  const villain = seat({ seat: 0, committed: 0, total: 0 });
  const me: DecisionSeat = {
    seat: 1,
    userId: 1,
    displayName: 'hero',
    isMe: true,
    stack: 1000,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
  };
  const hand: DecisionHand = {
    handId: 'h1',
    street: board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : 'flop',
    buttonSeat: 1,
    board,
    pot,
    currentBet: 0,
    toAct: 1,
    deadline: null,
    myCards: hole,
    mySeat: 1,
  };
  const legal: DecisionLegalActions = {
    canCheck: true,
    canCall: false,
    callAmount: 0,
    canBet: true,
    canRaise: false,
    minRaiseTo: 40,
    maxRaiseTo: 1000,
  };
  const potOdds: DecisionPotOdds = {
    callAmount: 0,
    pot,
    potOdds: 0,
    breakEvenEquity: 0,
  };
  return {
    room: { id: 'r', name: 'r', sb: 1, bb: 2, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand,
    me,
    legalActions: legal,
    potOdds,
    actionHistory: [],
    opponents: [villain],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder: [0, 1],
    actionSeq: seq,
  };
}

interface Rates {
  fold: number;
  call: number;
  valueRaise: number;
  otherRaise: number;
}

/** Action mix over `n` distinct actionSeq seeds (each is an independent RNG draw). */
function ratesFor(
  hole: CardId[],
  board: CardId[],
  pot: number,
  call: number,
  p: PostflopPolicy,
  n = 200,
): Rates {
  let fold = 0;
  let called = 0;
  let valueRaise = 0;
  let otherRaise = 0;
  for (let seq = 0; seq < n; seq++) {
    const d = p.decide(facingView(hole, board, pot, call, seq));
    const a = d.action.type;
    if (a === 'fold') fold++;
    else if (a === 'call') called++;
    else if (d.reason.includes('value raise')) valueRaise++;
    else otherRaise++;
  }
  return {
    fold: fold / n,
    call: called / n,
    valueRaise: valueRaise / n,
    otherRaise: otherRaise / n,
  };
}

// 4/2/1-pot bets: total pot includes the bet, so potBefore=P and call=0.4P ⇒
// facingView(P + 0.4P, 0.4P). The user's hand used P=100.
const BET_04 = { pot: 140, call: 40 } as const;

/** Fraction of `n` seeds where the unopened policy takes the *value* bet line. */
function valueBetRate(
  hole: CardId[],
  board: CardId[],
  pot: number,
  p: PostflopPolicy,
  n = 200,
): number {
  let bets = 0;
  for (let seq = 0; seq < n; seq++) {
    const d = p.decide(unopenedView(hole, board, pot, seq));
    if (d.action.type === 'bet' && d.reason.includes('postflop value')) bets++;
  }
  return bets / n;
}

// ---------------------------------------------------------------------------
// The user's hand: set of 4s, four-club river, hero has no club.
// ---------------------------------------------------------------------------

const USER_HOLE = [c('4d'), c('4s')];
const USER_BOARD = [c('Js'), c('7c'), c('Qc'), c('2c'), c('4c')];

describe('postflop board suppression: the four-flush set no longer value-raises', () => {
  it('never takes the value-raise line and mostly calls (not folds)', () => {
    const r = ratesFor(USER_HOLE, USER_BOARD, BET_04.pot, BET_04.call, policy());
    // The regression: `category >= 3` used to force a ~62% value raise here.
    expect(r.valueRaise).toBe(0);
    // The line is a call, not a fold: the equity (defend) path is untouched.
    expect(r.fold).toBe(0);
    expect(r.call).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// Protective counter-examples: the suppression must not leak onto real hands.
// ---------------------------------------------------------------------------

describe('postflop board suppression: never downgrades the nuts', () => {
  it('still value-raises the nut flush on a four-flush board', () => {
    const hole = [c('Ac'), c('3c')];
    const r = ratesFor(hole, USER_BOARD, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBeGreaterThan(0.4);
  });

  it('still value-raises a second-nut flush on a four-flush board', () => {
    const hole = [c('Kc'), c('3c')];
    const r = ratesFor(hole, USER_BOARD, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBeGreaterThan(0.4);
  });

  it('still value-raises a full house on a paired four-flush board', () => {
    const board = [c('Jc'), c('7c'), c('4c'), c('2c'), c('Jd')];
    const hole = [c('Js'), c('7d')];
    const r = ratesFor(hole, board, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBeGreaterThan(0.4);
  });

  it('still value-raises quads on a paired four-flush board', () => {
    const board = [c('Jc'), c('7c'), c('4c'), c('2c'), c('Jd')];
    const hole = [c('Js'), c('Jh')];
    const r = ratesFor(hole, board, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBeGreaterThan(0.4);
  });
});

describe('postflop board suppression: dry boards are untouched', () => {
  it('keeps a dry-board set value-raising at its normal frequency', () => {
    const board = [c('Ks'), c('7d'), c('2h')];
    const hole = [c('7s'), c('7c')];
    const r = ratesFor(hole, board, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBeGreaterThan(0.45);
  });
});

describe('postflop board suppression: three-flush turn keeps its P1 behaviour', () => {
  const board = [c('Qc'), c('7c'), c('2c'), c('9h')];

  it('holds an exposed overpair back (P1 bluff-catcher discount)', () => {
    const hole = [c('Ks'), c('Kd')];
    const r = ratesFor(hole, board, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBeLessThan(0.2);
  });

  it('does not apply the overpair discount to a set', () => {
    const hole = [c('Qs'), c('Qd')];
    const r = ratesFor(hole, board, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBeGreaterThan(0.45);
  });
});

// ---------------------------------------------------------------------------
// The symmetric straight-board defect.
// ---------------------------------------------------------------------------

describe('postflop board suppression: four-to-a-straight board', () => {
  const board = [c('9s'), c('8d'), c('7c'), c('6h'), c('2s')];

  it('a set with no key straight card no longer value-raises', () => {
    const hole = [c('9d'), c('9c')]; // trips 9, holds neither 5 nor T
    const r = ratesFor(hole, board, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBe(0);
    expect(r.fold).toBe(0);
  });

  it('two pair with no key straight card no longer value-raises', () => {
    const hole = [c('9d'), c('2d')];
    const r = ratesFor(hole, board, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBe(0);
  });

  it('does not suppress a hero who holds the straight', () => {
    const hole = [c('Td'), c('2d')]; // T-9-8-7-6 straight
    const r = ratesFor(hole, board, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBeGreaterThan(0.4);
  });
});

// ---------------------------------------------------------------------------
// A three-to-straight board must NOT be treated as four-to-a-straight.
// ---------------------------------------------------------------------------

describe('postflop board suppression: board-only three-to-straight is not suppressed', () => {
  it('keeps a set value-raising on a three-to-a-straight board', () => {
    const board = [c('9s'), c('8d'), c('7c'), c('2h'), c('3s')];
    const hole = [c('9d'), c('9c')];
    const r = ratesFor(hole, board, BET_04.pot, BET_04.call, policy());
    expect(r.valueRaise).toBeGreaterThan(0.45);
  });
});

// ---------------------------------------------------------------------------
// Pure predicate semantics (fast, no RNG): the exact suppression set.
// ---------------------------------------------------------------------------

describe('postflop board suppression: madeHandSuppressedByBoard (pure)', () => {
  const suppressed = (hole: CardId[], board: CardId[]) =>
    madeHandSuppressedByBoard(hole, board, evaluateHand(hole, board), classifyTexture(board));

  it('suppresses non-flush made hands on a four-flush board with no suit card', () => {
    expect(suppressed(USER_HOLE, USER_BOARD)).toBe(true); // set of 4s
    expect(suppressed([c('Qd'), c('9d')], USER_BOARD)).toBe(true); // two pair
    expect(suppressed([c('Ad'), c('As')], USER_BOARD)).toBe(true); // overpair
    expect(suppressed([c('9s'), c('9h')], [c('8c'), c('7c'), c('6c'), c('5c'), c('2d')])).toBe(
      true, // straight on a four-flush board still loses to any flush
    );
  });

  it('never suppresses a made flush, full house, quads or straight flush', () => {
    expect(suppressed([c('Ac'), c('3c')], USER_BOARD)).toBe(false); // nut flush
    expect(suppressed([c('Kc'), c('3c')], USER_BOARD)).toBe(false); // second flush
    const paired = [c('Jc'), c('7c'), c('4c'), c('2c'), c('Jd')];
    expect(suppressed([c('Js'), c('7d')], paired)).toBe(false); // full house
    expect(suppressed([c('Js'), c('Jh')], paired)).toBe(false); // quads
  });

  it('suppresses board-only made hands (shared by every player)', () => {
    // Five-flush board, hero holds no card of the suit: hero merely plays the
    // board's flush. Exact reverse of the user's hand (oracle blocker 1).
    const fiveFlush = [c('Jc'), c('7c'), c('Qc'), c('2c'), c('4c')];
    expect(suppressed([c('5d'), c('6d')], fiveFlush)).toBe(true); // Q-high board flush

    // Board full house / quads / straight flush: the board alone makes them, so
    // they are shared, not hero's value (oracle blocker 2).
    expect(suppressed([c('As'), c('Kd')], [c('Jc'), c('Jd'), c('7c'), c('7d'), c('7h')])).toBe(
      true, // board 777 + JJ
    );
    expect(suppressed([c('3d'), c('4d')], [c('Jc'), c('Jd'), c('Jh'), c('Js'), c('7c')])).toBe(
      true, // board quads: hero plays the board's own kicker (7)
    );
    expect(suppressed([c('As'), c('Kd')], [c('5c'), c('6c'), c('7c'), c('8c'), c('9c')])).toBe(
      true, // board straight flush
    );
  });

  it('suppresses a board-only straight (hero zero contribution, cat 4)', () => {
    // `As Kd` on `5c 6d 7h 8s 9c`: hero's best five IS the board's 9-high
    // straight, so the straight is shared. The pre-fix `category >= 5` guard
    // let this through (category === 4) and the value leg still bet it.
    const board = [c('5c'), c('6d'), c('7h'), c('8s'), c('9c')];
    expect(suppressed([c('As'), c('Kd')], board)).toBe(true);
  });

  it('does not suppress a hero who truly upgrades the straight (cat 4)', () => {
    // Same board, but the `T` makes hero's own `T-9-8-7-6` straight, which beats
    // the shared board straight - this is real value and must stay unsuppressed.
    const board = [c('5c'), c('6d'), c('7h'), c('8s'), c('9c')];
    expect(suppressed([c('Th'), c('Kd')], board)).toBe(false);
  });

  it('suppresses board-only trips (analogous cat-3 gap)', () => {
    // `8d 4d` on `7h 7d 7c Ks 9s`: hero contributes nothing, the best five are
    // the board's own `777 K 9`. The value leg reads `category >= 3` (trips) as
    // value, so this is the same defect class as the straight.
    const board = [c('7h'), c('7d'), c('7c'), c('Ks'), c('9s')];
    expect(suppressed([c('8d'), c('4d')], board)).toBe(true);
  });

  it('does not suppress board quads when a hole kicker improves the board (kicker plays)', () => {
    // board = JJJJ + 7; hero As improves the fifth card from 7 to A. Hero does
    // NOT merely play the board - all four jacks are on the board, so the hand
    // is a pure kicker battle and hero holds the best possible kicker. Flagged
    // as an oracle over-reach: this spot must stay a value hand.
    expect(suppressed([c('As'), c('Kd')], [c('Jc'), c('Jd'), c('Jh'), c('Js'), c('7c')])).toBe(
      false,
    );
    // Same board, hero's kicker is worse than the board's fifth card: board-only.
    expect(suppressed([c('3d'), c('4d')], [c('Jc'), c('Jd'), c('Jh'), c('Js'), c('7c')])).toBe(
      true,
    );
  });

  it('does not suppress a board-level hand that hero actually upgrades', () => {
    // Board is a full house (777 + JJ); hero's J makes jacks full, a higher boat
    // that is hero's own, not the shared sevens full.
    expect(suppressed([c('Js'), c('2d')], [c('Jc'), c('Jd'), c('7c'), c('7d'), c('7h')])).toBe(
      false,
    );
  });

  it('does not suppress non-flush hands when hero holds a card of the suit', () => {
    // Set of 4s, but the hero also holds a club (blocker): return to normal.
    // (The old `[4d, 4c]` fixture duplicated the board's `4c`; corrected to a
    // real, non-overlapping blocker `6c`.)
    expect(suppressed([c('4d'), c('6c')], USER_BOARD)).toBe(false);
  });

  it('does not suppress on three-flush or dry boards', () => {
    expect(suppressed([c('Qs'), c('Qd')], [c('Qc'), c('7c'), c('2c'), c('9h')])).toBe(false);
    expect(suppressed([c('7s'), c('7c')], [c('Ks'), c('7d'), c('2h')])).toBe(false);
  });

  it('does not suppress weak board-only hands (a board pair is never value)', () => {
    // Paired three-flush board with two pair: maxSuit 3, board draw incomplete.
    expect(suppressed([c('8s'), c('8d')], [c('Qc'), c('Jc'), c('2c'), c('Qd'), c('7h')])).toBe(
      false,
    );
    // Hero plays the board's pair on a dry runout - no board draw completed.
    expect(suppressed([c('7c'), c('8c')], [c('Ah'), c('Kd'), c('Qs'), c('2h'), c('2s')])).toBe(
      false,
    );
  });

  it('suppresses only a non-straight hand on a four-to-a-straight board', () => {
    const board = [c('9s'), c('8d'), c('7c'), c('6h'), c('2s')];
    expect(suppressed([c('9d'), c('9c')], board)).toBe(true); // set, no 5/T
    expect(suppressed([c('9d'), c('2d')], board)).toBe(true); // two pair
    expect(suppressed([c('Td'), c('2d')], board)).toBe(false); // hero has the straight
    expect(suppressed([c('5d'), c('2d')], board)).toBe(false); // wheel end straight
    // Three-to-a-straight (no window with four board ranks) is not suppressed.
    expect(suppressed([c('9d'), c('9c')], [c('9s'), c('8d'), c('7c'), c('2h'), c('3s')])).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Isomorphic defect in the unopened (checked-to) value bet: the same board-aware
// predicate must gate `value`, or the user's four-flush set still bets 100%.
// ---------------------------------------------------------------------------

describe('postflop board suppression: the unopened value bet is gated too', () => {
  it("does not value-bet the user's four-flush set when checked to", () => {
    const r = valueBetRate(USER_HOLE, USER_BOARD, 100, policy());
    // Before: `category >= 3` made this a ~99% value bet.
    expect(r).toBe(0);
  });

  it('does not value-bet board-only made hands when checked to', () => {
    const fiveFlush = [c('Jc'), c('7c'), c('Qc'), c('2c'), c('4c')];
    expect(valueBetRate([c('5d'), c('6d')], fiveFlush, 100, policy())).toBe(0);
    expect(
      valueBetRate([c('As'), c('Kd')], [c('Jc'), c('Jd'), c('7c'), c('7d'), c('7h')], 100, policy()),
    ).toBe(0);
    // board quads with a non-playing hole card (hero plays the board's kicker)
    expect(
      valueBetRate([c('3d'), c('4d')], [c('Jc'), c('Jd'), c('Jh'), c('Js'), c('7c')], 100, policy()),
    ).toBe(0);
  });

  it('does not value-bet a board-only straight when checked to (branch isolation)', () => {
    // The unopened value leg is `!boardSuppressed && (category >= 3 || pct >=
    // 0.8)` with NO equity fallback, so this asserts the suppression branch
    // itself (unlike the facing-bet `equity >= 0.8` leg, which can mask a
    // regression). `As Kd` on `5c 6d 7h 8s 9c`: hero's best five are the
    // board's own straight, so `valueBetRate` must be exactly 0.
    const board = [c('5c'), c('6d'), c('7h'), c('8s'), c('9c')];
    expect(valueBetRate([c('As'), c('Kd')], board, 100, policy())).toBe(0);
  });

  it('still value-bets a hero-contributed straight on the same board', () => {
    // Same runout, but hero's `T` makes `T-9-8-7-6` - a genuinely better
    // straight than the shared board runout. Must keep value betting.
    const board = [c('5c'), c('6d'), c('7h'), c('8s'), c('9c')];
    expect(valueBetRate([c('Th'), c('Kd')], board, 100, policy())).toBeGreaterThan(0.5);
  });

  it('still value-bets a dry-board set when checked to', () => {
    const board = [c('Ks'), c('7d'), c('2h')];
    expect(valueBetRate([c('7s'), c('7c')], board, 100, policy())).toBeGreaterThan(0.5);
  });

  it('still value-bets a hero-contributed full house when checked to', () => {
    const board = [c('Jc'), c('7c'), c('4c'), c('2c'), c('Jd')];
    expect(valueBetRate([c('Js'), c('7d')], board, 100, policy())).toBeGreaterThan(0.5);
  });
});
