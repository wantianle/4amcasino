import { describe, expect, it } from 'vitest';
import { ALL_CARDS, cardFromName, type CardId } from '@4am/shared';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionPotOdds,
  DecisionSeat,
  DecisionView,
  OpponentStats,
  PublicAction,
  SessionMemory,
} from '../src/decisionView.js';
import {
  DEFAULT_P2,
  DRAW_BUCKETS,
  MADE_BUCKETS,
  P2_ALL_OFF,
  POSTFLOP_SIZE_GRID,
  PostflopPolicy,
  bucketAdvantage,
  bucketStrength,
  buildVillainRange,
  chooseVillainModel,
  evaluateHand,
  facingVillainModel,
  facingVillainRange,
  gridFraction,
  handBucket,
  opponentModelStats,
  snapBetFraction,
  snapOpponentRead,
  type P2Options,
} from '../src/postflopPolicy.js';
import { estimateEquity } from '../src/equity.js';
import { RULE_PRESETS } from '../src/ruleStyles.js';
import { BaselinePostflopPolicy } from './fixtures/postflopPolicyBaseline.js';

const c = (n: string) => cardFromName(n);
const SEED = 7;
const PARAMS = RULE_PRESETS['tight-aggressive'];
const policy = (p2?: Partial<P2Options>) =>
  new PostflopPolicy({ params: PARAMS, seed: SEED, p2 });

// ---------------------------------------------------------------------------
// view builders (mirrors the P0/P1 suites)
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

function hero(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
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
    ...over,
  };
}

function roomAndHand(
  hole: CardId[],
  board: CardId[],
): { room: DecisionView['room']; hand: DecisionHand } {
  return {
    room: { id: 'r', name: 'r', sb: 1, bb: 2, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: {
      handId: 'h1',
      street: board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : 'flop',
      buttonSeat: 1,
      board,
      pot: 0,
      currentBet: 0,
      toAct: 1,
      deadline: null,
      myCards: hole,
      mySeat: 1,
    },
  };
}

function facingView(
  hole: CardId[],
  board: CardId[],
  pot: number,
  call: number,
  over: Partial<DecisionView> = {},
): DecisionView {
  const villain = seat({ seat: 0, committed: call, total: call });
  const me = hero({ committed: call, total: call });
  const { room, hand } = roomAndHand(hole, board);
  hand.pot = pot;
  hand.currentBet = call;
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
    room,
    hand,
    me,
    legalActions: legal,
    potOdds,
    actionHistory: [],
    opponents: [villain],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder: [0, 1],
    actionSeq: 0,
    ...over,
  };
}

function unopenedView(
  hole: CardId[],
  board: CardId[],
  pot: number,
  over: Partial<DecisionView> = {},
): DecisionView {
  const villain = seat({ seat: 0 });
  const me = hero();
  const { room, hand } = roomAndHand(hole, board);
  hand.pot = pot;
  hand.currentBet = 0;
  const legal: DecisionLegalActions = {
    canCheck: true,
    canCall: false,
    callAmount: 0,
    canBet: true,
    canRaise: false,
    minRaiseTo: 2,
    maxRaiseTo: 1000,
  };
  const potOdds: DecisionPotOdds = {
    callAmount: 0,
    pot,
    potOdds: 0,
    breakEvenEquity: 0,
  };
  return {
    room,
    hand,
    me,
    legalActions: legal,
    potOdds,
    actionHistory: [],
    opponents: [villain],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder: [0, 1],
    actionSeq: 0,
    ...over,
  };
}

function stats(vpip: number, pfr: number, sample = 50): OpponentStats {
  return {
    seat: 0,
    sampleHands: sample,
    vpipHands: Math.round(vpip * sample),
    pfrHands: Math.round(pfr * sample),
    postflopBetsRaises: 0,
    postflopCalls: 0,
  };
}

function memoryWith(...opponents: OpponentStats[]): SessionMemory {
  return { handsObserved: 50, netChips: null, recentHands: [], opponents };
}

function preflopRaise(seatNo: number, seq: number): PublicAction {
  return {
    actionSeq: seq,
    street: 'preflop',
    seat: seatNo,
    action: { type: 'raise', amount: 6 },
    auto: false,
    ts: 0,
  };
}

/** Count final actions over `n` fixed-seed views (deterministic action rate). */
function actionCounts(
  p: PostflopPolicy,
  makeView: (seq: number) => DecisionView,
  n = 240,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let seq = 0; seq < n; seq++) {
    const d = p.decide(makeView(seq));
    counts[d.action.type] = (counts[d.action.type] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// #2 opponent model (permanent `sampleHands < 10` cutoff)
// ---------------------------------------------------------------------------

describe('postflop P2: opponent model cutoff', () => {
  it('opponentModelStats keeps the sampleHands < 10 cutoff (permanent post-prune)', () => {
    // A 2-of-5 voluntary rate: below the cutoff, so it is discarded entirely and
    // the table reads as a neutral "no read". This is the fixed behaviour that
    // replaced the deleted `shrinkage` posterior-mean branch.
    const view = facingView([c('Qs'), c('Qd')], [c('Kh'), c('7d'), c('2c')], 150, 50, {
      sessionMemory: memoryWith(stats(0.4, 0, 5)),
    });
    expect(opponentModelStats(view)).toEqual({});
  });

  it('reads the station / nit exploit bands from raw rates above the cutoff', () => {
    const villain = [seat({ seat: 0 })];
    const withStats = (s: OpponentStats) =>
      facingView([c('8s'), c('3s')], [c('Ks'), c('7s'), c('2d')], 100, 0, {
        opponents: villain,
        sessionMemory: memoryWith(s),
      });
    const station = opponentModelStats(withStats(stats(0.6, 0.1)))!;
    expect(station.vpip!).toBeGreaterThan(0.45);
    expect(station.pfr!).toBeLessThan(0.18);
    const nit = opponentModelStats(withStats(stats(0.1, 0.05)))!;
    expect(nit.vpip!).toBeLessThan(0.22);
  });
});

// ---------------------------------------------------------------------------
// #3 bet-size grid
// ---------------------------------------------------------------------------

describe('postflop P2: bet-size grid + nearest-neighbour translation', () => {
  it('maps weird sizes to their nearest grid point', () => {
    expect(snapBetFraction(0.2)).toBe(0.33);
    expect(snapBetFraction(0.42)).toBe(0.5);
    expect(snapBetFraction(0.5)).toBe(0.5);
    expect(snapBetFraction(0.64)).toBe(0.75);
    expect(snapBetFraction(0.9)).toBe(1.0);
    expect(snapBetFraction(1.1)).toBe(1.0);
    expect(snapBetFraction(1.4)).toBe(1.5);
    expect(snapBetFraction(3.0)).toBe(1.5); // oversized reads as the top grid point
    expect(snapBetFraction(0.1)).toBe(0.33);
    for (const point of POSTFLOP_SIZE_GRID) expect(snapBetFraction(point)).toBe(point);
  });

  it('always reads a flagged all-in as all-in, and fails safe on junk', () => {
    expect(snapBetFraction(0.33, true)).toBe('all-in');
    expect(snapBetFraction(12, true)).toBe('all-in');
    expect(gridFraction('all-in')).toBe(POSTFLOP_SIZE_GRID[POSTFLOP_SIZE_GRID.length - 1]);
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(snapBetFraction(junk)).toBe(0.5);
    }
  });

  it('snaps a junk read to the street grid, never to a size the street lacks', () => {
    // Blocker 2: the neutral fallback must exist ON the street's own grid. The
    // flop has no 0.5 tier, so a non-finite/non-positive read is 0.33 there.
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(snapBetFraction(junk, false, 'flop')).toBe(0.33);
      expect(snapBetFraction(junk, false, 'turn')).toBe(0.5);
      expect(snapBetFraction(junk, false, 'river')).toBe(0.5);
    }
    // And an ordinary 0.5-pot observation snaps down on the flop too.
    expect(snapBetFraction(0.5, false, 'flop')).toBe(0.33);
    expect(snapBetFraction(0.9, false, 'flop')).toBe(0.75);
    // Turn/river: 0.9 is nearer 1.0 than 0.75; 0.4 is nearer each grid's low tier.
    expect(snapBetFraction(0.9, false, 'turn')).toBe(1.0);
    expect(snapBetFraction(0.9, false, 'river')).toBe(1.0);
    expect(snapBetFraction(0.4, false, 'flop')).toBe(0.33);
    expect(snapBetFraction(0.4, false, 'turn')).toBe(0.5); // turn has no 0.33 tier
    expect(snapBetFraction(0.4, false, 'river')).toBe(0.33);
  });

  it('rounds just below / above a midpoint to the nearer side, and is idempotent', () => {
    expect(snapBetFraction(0.414)).toBe(0.33);
    expect(snapBetFraction(0.416)).toBe(0.5);
    expect(snapBetFraction(0.624)).toBe(0.5);
    expect(snapBetFraction(0.626)).toBe(0.75);
    for (const point of POSTFLOP_SIZE_GRID) {
      expect(snapBetFraction(gridFraction(snapBetFraction(point)))).toBe(point);
    }
  });

  it('ties an exact midpoint to the lower size by design (documented, not a bug)', () => {
    // Midpoints of the grid: 0.415, 0.625, 0.875.
    expect(snapBetFraction(0.415)).toBe(0.33); // NOT 0.5
    expect(snapBetFraction(0.625)).toBe(0.5); // NOT 0.75
    expect(snapBetFraction(0.875)).toBe(0.75); // NOT 1.0
    // Just above the midpoint flips to the higher size; the strict `<` is the
    // only thing making the tie lower.
    expect(snapBetFraction(0.4151)).toBe(0.5);
    expect(snapBetFraction(0.6251)).toBe(0.75);
    expect(snapBetFraction(0.8751)).toBe(1.0);
  });

  it('translates an odd 0.9-pot bet to the large tier, not the neutral tier', () => {
    const base = { allIn: false, heroWasAggressor: false, wet: false };
    // Raw continuous read: 0.9 sits in no size bucket -> balanced.
    expect(chooseVillainModel({ ...base, betFraction: 0.9 }, false)).toBe('balanced');
    // Grid read: 0.9 snaps to 1.0 pot -> value-heavy. This is the intentional
    // behaviour change of the sizeGrid switch (on by default since 2026-10-06).
    expect(chooseVillainModel({ ...base, betFraction: 0.9 }, true)).toBe('value-heavy');
  });

  it('snaps the opponent read to the global grid, never a per-street one', () => {
    // The opponent is not bound by our action abstraction, so the same observed
    // size must read the same on every street. `snapOpponentRead` uses the
    // global read grid: 0.9 -> 1.0 (0.1) not 0.75 (0.15); 0.4 -> 0.33 (0.07)
    // not 0.5 (0.1).
    expect(snapOpponentRead(0.9)).toBe(1.0);
    expect(snapOpponentRead(0.4)).toBe(0.33);
    expect(snapOpponentRead(0.5)).toBe(0.5);
    expect(gridFraction(snapOpponentRead(0.9))).toBe(1.0);
    // Junk reads as the neutral half-pot, which is on the global grid.
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(snapOpponentRead(junk)).toBe(0.5);
    }
    expect(snapOpponentRead(0.33, true)).toBe('all-in');
  });

  it('classifies an opponent size identically on every street (global read)', () => {
    const base = { allIn: false, heroWasAggressor: false, wet: false };
    // `street` is no longer an input to the read. A per-street read made a
    // 0.9-pot bet `balanced` on the flop (snapped to 0.75) but `value-heavy` on
    // turn/river (snapped to 1.0) purely because our own action grid differed.
    expect(chooseVillainModel({ ...base, betFraction: 0.9 })).toBe('value-heavy');
    expect(chooseVillainModel({ ...base, betFraction: 0.4 })).toBe('bluff-heavy');
    // Turn/river-sized reads are unchanged from the old default (river grid).
    expect(chooseVillainModel({ ...base, betFraction: 0.5 })).toBe('balanced');
  });

  it('does not change the P0 size buckets for the canonical sizes', () => {
    const base = { allIn: false, heroWasAggressor: false, wet: false };
    expect(chooseVillainModel({ ...base, betFraction: 0.33 })).toBe('bluff-heavy');
    expect(chooseVillainModel({ ...base, betFraction: 0.5 })).toBe('balanced');
    expect(chooseVillainModel({ ...base, betFraction: 0.75 })).toBe('balanced');
    expect(chooseVillainModel({ ...base, betFraction: 1 })).toBe('value-heavy');
    expect(chooseVillainModel({ ...base, betFraction: 2 })).toBe('value-heavy');
    expect(chooseVillainModel({ ...base, betFraction: 0.5, allIn: true })).toBe('value-heavy');
    // The default `sizeGrid` argument follows DEFAULT_P2 (on since the
    // 2026-10-06 product decision), so a single-argument call snaps the odd
    // 0.9-pot bet to 1.0 -> value-heavy.
    expect(chooseVillainModel({ ...base, betFraction: 0.9 })).toBe('value-heavy');
    // An explicit off keeps the raw-continuous read.
    expect(chooseVillainModel({ ...base, betFraction: 0.9 }, false)).toBe('balanced');
  });
});

// ---------------------------------------------------------------------------
// #4 24 hand-strength buckets
// ---------------------------------------------------------------------------

describe('postflop P2: 24 hand-strength buckets', () => {
  const DRY = [c('Kh'), c('7d'), c('2c')];

  it('classifies the typical made-hand states', () => {
    expect(handBucket([c('8s'), c('3d')], DRY).made).toBe('air');
    expect(handBucket([c('Kc'), c('Qd')], DRY).made).toBe('top-pair'); // pair of kings
    expect(handBucket([c('7c'), c('6d')], DRY).made).toBe('mid-pair'); // pair of sevens
    expect(handBucket([c('2h'), c('3d')], DRY).made).toBe('weak-pair'); // pair of deuces
    expect(handBucket([c('Kc'), c('Kd')], DRY).made).toBe('strong-made'); // set of kings
    expect(handBucket([c('Ac'), c('Ad')], DRY).made).toBe('top-pair'); // overpair
    expect(handBucket([c('9s'), c('9d')], DRY).made).toBe('mid-pair'); // underpair above the 7
    expect(handBucket([c('3c'), c('3d')], DRY).made).toBe('weak-pair'); // underpair below the second card
    expect(handBucket([c('Kc'), c('7c')], DRY).made).toBe('two-pair-plus');
  });

  it('maps every category >= 3 (set/trips .. straight flush) to strong-made', () => {
    // set / trips
    expect(handBucket([c('Kc'), c('Kd')], DRY).made).toBe('strong-made');
    expect(handBucket([c('Kc'), c('Qd')], [c('Kh'), c('Kd'), c('2c')]).made).toBe('strong-made');
    // two pair is its own tier, not strong-made
    expect(handBucket([c('Kc'), c('7c')], DRY).made).toBe('two-pair-plus');
    // made straight
    const straight = handBucket([c('Th'), c('Jd')], [c('9h'), c('8c'), c('7d')]);
    expect(straight.made).toBe('strong-made');
    expect(evaluateHand([c('Th'), c('Jd')], [c('9h'), c('8c'), c('7d')]).category).toBe(4);
    // made flush
    const flush = handBucket([c('Kh'), c('7h')], [c('Qh'), c('9h'), c('4h')]);
    expect(flush.made).toBe('strong-made');
    expect(evaluateHand([c('Kh'), c('7h')], [c('Qh'), c('9h'), c('4h')]).category).toBe(5);
    // full house
    const boat = handBucket([c('Kc'), c('Kd')], [c('Kh'), c('7d'), c('7c')]);
    expect(boat.made).toBe('strong-made');
    expect(evaluateHand([c('Kc'), c('Kd')], [c('Kh'), c('7d'), c('7c')]).category).toBe(6);
    // straight flush
    const sf = handBucket([c('Th'), c('Jh')], [c('9h'), c('8h'), c('7h')]);
    expect(sf.made).toBe('strong-made');
    expect(evaluateHand([c('Th'), c('Jh')], [c('9h'), c('8h'), c('7h')]).category).toBe(8);
    // Every one of the above is category >= 3 and lands in strong-made, i.e. the
    // classifier deliberately does NOT split set/straight/flush/boat/SF.
  });

  it('classifies the draw states and merges flush/straight into the 4 draw buckets', () => {
    const straightBoard = [c('9h'), c('8c'), c('2d')];
    expect(handBucket([c('Th'), c('Jd')], straightBoard).draw).toBe('strong-draw'); // OESD
    const gutshotBoard = [c('8h'), c('4c'), c('Kd')];
    expect(handBucket([c('6s'), c('5d')], gutshotBoard).draw).toBe('gutshot'); // needs a 7
    const threeFlush = [c('Qh'), c('9h'), c('4h'), c('2c')];
    expect(handBucket([c('Kh'), c('Kd')], threeFlush).draw).toBe('strong-draw'); // pure flush draw
    const comboBoard = [c('9h'), c('8h'), c('2c')];
    expect(handBucket([c('Th'), c('Jh')], comboBoard).draw).toBe('combo-draw'); // flush + OESD
    expect(handBucket([c('8s'), c('3d')], DRY).draw).toBe('none');
    // The draw axis is a heuristic rank-completion count (see `evaluateHand`),
    // not exact outs: it only distinguishes gutshot / OESD-or-flush / both.
  });

  it('counts a four-flush as a draw only when hero holds a card of the suit', () => {
    // Board-only four-flush: hero holds no heart, so this is NOT hero's draw.
    const boardFourFlush = [c('Qh'), c('9h'), c('4h'), c('2h')];
    expect(evaluateHand([c('Ks'), c('Kd')], boardFourFlush).flushDraw).toBe(false);
    expect(handBucket([c('Ks'), c('Kd')], boardFourFlush).draw).toBe('none');
    // Hole-card four-flush: three hearts on the board + hero's Kh = exactly four
    // to the suit -> a real draw (a fourth board heart would already be a flush).
    const threeHeartBoard = [c('Qh'), c('9h'), c('4h')];
    expect(evaluateHand([c('Kh'), c('Kd')], threeHeartBoard).flushDraw).toBe(true);
    expect(handBucket([c('Kh'), c('Kd')], threeHeartBoard).draw).toBe('strong-draw');
    // Five hearts total is a made flush, not a draw.
    const fourHeartBoard = [c('Qh'), c('9h'), c('4h'), c('2h')];
    expect(evaluateHand([c('Kh'), c('Kd')], fourHeartBoard).category).toBe(5);
    expect(evaluateHand([c('Kh'), c('Kd')], fourHeartBoard).flushDraw).toBe(false);
    // Board-only straight draw is likewise not attributed to hero.
    expect(evaluateHand([c('2s'), c('3d')], [c('9h'), c('8c'), c('7d')]).straightDraw).toBe(0);
  });

  it('does not attribute a four-board-card straight completion to hero (P0-1)', () => {
    // The board itself is 9-8-7-6, so the 5 / T that complete the straight make
    // it entirely with board cards: As Kd contributes no rank and has no draw.
    // Before the P0-1 fix this read `straightDraw: 2` / `draw: 'strong-draw'`.
    const fourBoard = [c('9h'), c('8c'), c('7d'), c('6s')];
    const boardOnly = evaluateHand([c('As'), c('Kd')], fourBoard);
    expect(boardOnly.straightDraw).toBe(0);
    expect(handBucket([c('As'), c('Kd')], fourBoard).draw).toBe('none');

    // Same board, but hero's J sits inside the 7-8-9-T-J window: the T completes
    // a straight that DOES use a hole card, so exactly that one out counts. The
    // board-only 5 (5-6-7-8-9) still does not, and neither does a pure board
    // straight using no hole rank.
    const assisted = evaluateHand([c('Qd'), c('Jh')], fourBoard);
    expect(assisted.straightDraw).toBe(1);
    expect(handBucket([c('Qd'), c('Jh')], fourBoard).draw).toBe('gutshot');

    // Hole-assisted outs are preserved: an OESD through hero's T/J, and a
    // gutshot through hero's 6/5, both keep counting.
    expect(evaluateHand([c('Th'), c('Jd')], [c('9h'), c('8c'), c('2d')]).straightDraw).toBe(2);
    expect(evaluateHand([c('6s'), c('5d')], [c('8h'), c('4c'), c('Kd')]).straightDraw).toBe(1);
  });

  it('a hero rank already on the board is not a unique contribution (P0, rank source)', () => {
    // Board Ah Qc Jd Tc; the board's K completes A-K-Q-J-T. hero As 2d's ace
    // rank is already public, so this is a board-only straight -> no draw.
    // Before the rank-source fix `window.some(heroRank)` counted the shared ace
    // and read 1.
    const board = [c('Ah'), c('Qc'), c('Jd'), c('Tc')];
    expect(evaluateHand([c('As'), c('2d')], board).straightDraw).toBe(0);
    expect(handBucket([c('As'), c('2d')], board).draw).toBe('none');

    // hero As Kd on the same board already HAS the A-K-Q-J-T straight: a made
    // straight reports no draw at all (semantic decision, see `evaluateHand`).
    const made = evaluateHand([c('As'), c('Kd')], board);
    expect(made.category).toBe(4);
    expect(made.straightDraw).toBe(0);

    // Wheel with the shared ace: board Ac 2d 3h 4s + hero As; the 5 completes
    // A-2-3-4-5, but the ace is board-only -> not hero's draw.
    const wheelBoard = [c('Ac'), c('2d'), c('3h'), c('4s')];
    expect(evaluateHand([c('As'), c('Kd')], wheelBoard).straightDraw).toBe(0);
  });

  it('counts only draws hero uniquely supplies, incl. one-card and wheel cases (P0)', () => {
    // One hole card inside the window: hero T on 9-8-6, only the 7 completes
    // 6-7-8-9-T through hero's T -> a single gutshot out.
    expect(evaluateHand([c('Th'), c('2d')], [c('9h'), c('8c'), c('6d')]).straightDraw).toBe(1);
    // Two hole cards: hero T/9 on 8-7, the 6 and J complete 6-7-8-9-T and
    // 7-8-9-T-J, both using hole ranks the board does not provide.
    expect(evaluateHand([c('Th'), c('9d')], [c('8c'), c('7d'), c('2s')]).straightDraw).toBe(2);
    // Wheel through a unique hole rank: hero As on 2-3-4, the 5 completes
    // A-2-3-4-5 through hero's ace (the board does not hold an ace).
    expect(evaluateHand([c('As'), c('Kd')], [c('2c'), c('3d'), c('4s')]).straightDraw).toBe(1);
  });

  it('is mutually exclusive and complete: every combo maps to exactly one of 24', () => {
    const boards: CardId[][] = [
      DRY,
      [c('Th'), c('9h'), c('8h')],
      [c('Qh'), c('Jh'), c('2c')],
      [c('5s'), c('7s'), c('9s'), c('Js'), c('2d')],
      [c('2d'), c('2h'), c('7c'), c('9s'), c('Ah')],
    ];
    const seen = new Set<number>();
    for (const board of boards) {
      const boardSet = new Set(board);
      const deck = ALL_CARDS.filter((card) => !boardSet.has(card));
      for (let i = 0; i < deck.length; i++) {
        for (let j = i + 1; j < deck.length; j++) {
          const bucket = handBucket([deck[i]!, deck[j]!], board);
          expect(Number.isInteger(bucket.index)).toBe(true);
          expect(bucket.index).toBeGreaterThanOrEqual(0);
          expect(bucket.index).toBeLessThan(24);
          expect(MADE_BUCKETS).toContain(bucket.made);
          expect(DRAW_BUCKETS).toContain(bucket.draw);
          expect(bucket.index).toBe(
            MADE_BUCKETS.indexOf(bucket.made) * DRAW_BUCKETS.length +
              DRAW_BUCKETS.indexOf(bucket.draw),
          );
          expect(bucket.id).toBe(`${bucket.made}/${bucket.draw}`);
          seen.add(bucket.index);
        }
      }
    }
    // The typical boards above collectively exercise a large part of the grid.
    expect(seen.size).toBeGreaterThanOrEqual(12);
  });

  it('bucketStrength is monotone across the made tiers and rewards draws', () => {
    const strength = (hole: CardId[]) => bucketStrength(handBucket(hole, DRY));
    const air = strength([c('8s'), c('3d')]);
    const weak = strength([c('2h'), c('3d')]);
    const mid = strength([c('7c'), c('6d')]);
    const top = strength([c('Kc'), c('Qd')]);
    const strong = strength([c('Kc'), c('Kd')]);
    expect(weak).toBeGreaterThan(air);
    expect(mid).toBeGreaterThan(weak);
    expect(top).toBeGreaterThan(mid);
    expect(strong).toBeGreaterThan(top);

    const drawBoard = [c('9h'), c('8h'), c('2c')];
    const combo = handBucket([c('Th'), c('Jh')], drawBoard);
    const none = { ...combo, draw: 'none' as const };
    expect(bucketStrength(combo)).toBeGreaterThan(bucketStrength(none));
  });

  it('bucketAdvantage is positive for a strong hero and bounded (experimental API)', () => {
    const range = buildVillainRange([c('8s'), c('3d')], DRY, 'balanced');
    const strong = bucketAdvantage([c('Kc'), c('Kd')], DRY, range);
    const air = bucketAdvantage([c('8s'), c('3d')], DRY, range);
    expect(strong).toBeGreaterThan(air);
    expect(strong).toBeLessThanOrEqual(1);
    expect(air).toBeGreaterThanOrEqual(-1);
    // Empty range is neutral, not NaN.
    expect(bucketAdvantage([c('Kc'), c('Kd')], DRY, [])).toBe(0);
    // NOT wired into any decision: `bucketAdvantage` has no caller in the policy
    // (the `buckets` switch reweights the villain range elsewhere). Eval probe only.
  });
});

// ---------------------------------------------------------------------------
// toggles / decision-level on-vs-off / integration / legality
// ---------------------------------------------------------------------------

describe('postflop P2: decision-level on-vs-off', () => {
  const DRY = [c('Kh'), c('7d'), c('2c')];
  // Explicit all-off: the pre-P2 control for the two surviving switches.
  const OFF: P2Options = { sizeGrid: false, buckets: false };

  it('sizeGrid changes the villain model, range weights and the action rate', () => {
    // call/potBefore = 90/100 = 0.9 pot: raw-continuous reads balanced, the grid
    // snaps it to 1.0 pot and reads value-heavy. A **river** board is used
    // because the grid is per-street since 2026-10-07: on the flop 0.9 would
    // snap to 0.75 (balanced), so the read only discriminates on the river/turn
    // ladder that actually contains a 1.0 tier.
    const view = (seq: number) =>
      facingView([c('3s'), c('3d')], [c('Kh'), c('9c'), c('4d'), c('2s'), c('7h')], 190, 90, {
        actionSeq: seq,
      });
    expect(facingVillainModel(view(0), 100, 90, OFF)).toBe('balanced');
    expect(facingVillainModel(view(0), 100, 90, { ...OFF, sizeGrid: true })).toBe('value-heavy');

    const wOff = facingVillainRange(view(0), [c('3s'), c('3d')], 100, 90, OFF).combos!;
    const wOn = facingVillainRange(view(0), [c('3s'), c('3d')], 100, 90, {
      ...OFF,
      sizeGrid: true,
    }).combos!;
    expect(wOn.length).toBe(wOff.length);
    expect(wOn.some((combo, i) => Math.abs(combo.weight - wOff[i]!.weight) > 1e-9)).toBe(true);

    const offCounts = actionCounts(policy(OFF), view);
    const onCounts = actionCounts(policy({ ...OFF, sizeGrid: true }), view);
    expect(onCounts).not.toEqual(offCounts);
    // A value-heavy read folds the underpairs more, not less.
    expect(onCounts.fold ?? 0).toBeGreaterThan(offCounts.fold ?? 0);
  });

  it('buckets reweight the villain range, move equity and can move the action rate', () => {
    const hole = [c('3s'), c('3d')];
    const board = [c('Th'), c('9h'), c('8h')];
    const view = (seq: number) => facingView(hole, board, 150, 50, { actionSeq: seq });
    const wOff = facingVillainRange(view(0), hole, 100, 50, OFF).combos!;
    const wOn = facingVillainRange(view(0), hole, 100, 50, { ...OFF, buckets: true }).combos!;
    expect(wOn.length).toBe(wOff.length);
    let changed = 0;
    for (let i = 0; i < wOn.length; i++) {
      expect(Number.isFinite(wOn[i]!.weight)).toBe(true);
      expect(wOn[i]!.weight).toBeGreaterThan(0);
      if (Math.abs(wOn[i]!.weight - wOff[i]!.weight) > 1e-9) changed++;
    }
    expect(changed).toBeGreaterThan(0);

    const eqOff = estimateEquity({
      hole,
      board,
      samples: 512,
      seed: 1,
      villainRange: facingVillainRange(view(0), hole, 100, 50, OFF),
    }).equity;
    const eqOn = estimateEquity({
      hole,
      board,
      samples: 512,
      seed: 1,
      villainRange: facingVillainRange(view(0), hole, 100, 50, { ...OFF, buckets: true }),
    }).equity;
    expect(eqOn).not.toBe(eqOff);

    const offCounts = actionCounts(policy(OFF), view);
    const onCounts = actionCounts(policy({ ...OFF, buckets: true }), view);
    expect(onCounts).not.toEqual(offCounts);
    expect(onCounts.fold ?? 0).toBeGreaterThan(offCounts.fold ?? 0);
  });

  it('each feature can be disabled independently', () => {
    const p = policy(OFF);
    const board = DRY;
    for (let seq = 0; seq < 30; seq++) {
      const v = facingView([c('Qs'), c('Qd')], board, 150, 50, { actionSeq: seq });
      const d = p.decide(v);
      expect(['fold', 'call', 'raise']).toContain(d.action.type);
    }
    // sizeGrid off: the odd 0.9 size is read continuously (balanced).
    expect(chooseVillainModel({ allIn: false, heroWasAggressor: false, wet: false, betFraction: 0.9 }, false)).toBe(
      'balanced',
    );
  });

  it('enabling buckets changes villain weights deterministically, keeping them finite', () => {
    const hole = [c('As'), c('Kd')];
    const board = [c('Qh'), c('9h'), c('4h'), c('2c')];
    const without = buildVillainRange(hole, board, 'balanced', { ...DEFAULT_P2, buckets: false });
    const with_ = buildVillainRange(hole, board, 'balanced', { ...DEFAULT_P2, buckets: true });
    expect(with_).toEqual(buildVillainRange(hole, board, 'balanced', { ...DEFAULT_P2, buckets: true }));
    expect(with_.length).toBe(without.length);
    let total = 0;
    let changed = 0;
    for (let i = 0; i < with_.length; i++) {
      const w = with_[i]!.weight;
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
      total += w;
      if (Math.abs(w - without[i]!.weight) > 1e-9) changed++;
    }
    expect(total).toBeGreaterThan(0);
    expect(changed).toBeGreaterThan(0);
  });

  it('the P2 policy still returns legal actions across boards and toggles', () => {
    const boards: CardId[][] = [DRY, [c('Th'), c('9h'), c('8h')], [c('5s'), c('7s'), c('9s'), c('Js'), c('2d')]];
    const configs: Partial<P2Options>[] = [
      {},
      { buckets: true },
      { sizeGrid: false, buckets: false },
    ];
    for (const p2 of configs) {
      const p = policy(p2);
      for (const board of boards) {
        for (const hole of [[c('Ac'), c('Kd')], [c('7c'), c('2d')], [c('8s'), c('8d')]] as CardId[][]) {
          const v = facingView(hole, board, 200, 100, { actionSeq: 3 });
          const d = p.decide(v);
          const la = v.legalActions!;
          if (d.action.type === 'raise') {
            expect(d.action.amount).toBeGreaterThanOrEqual(la.minRaiseTo);
            expect(d.action.amount).toBeLessThanOrEqual(la.maxRaiseTo);
          }
          expect(['fold', 'call', 'raise']).toContain(d.action.type);
        }
      }
    }
  });

  it('same view + seed decides identically with the default P2 settings', () => {
    const p = policy();
    const v = () =>
      facingView([c('Qs'), c('Qd')], DRY, 150, 50, {
        actionSeq: 3,
        actionHistory: [preflopRaise(0, 0), preflopRaise(0, 1)],
      });
    const first = p.decide(v());
    for (let i = 0; i < 50; i++) expect(p.decide(v())).toEqual(first);
  });

  it('DEFAULT_P2 is frozen with buckets + sizeGrid on; P2_ALL_OFF stays the all-off control', () => {
    // The constant must not be a mutable object that default parameters alias,
    // or `DEFAULT_P2.sizeGrid = false` would silently flip every default read.
    expect(Object.isFrozen(DEFAULT_P2)).toBe(true);
    for (const key of ['sizeGrid', 'buckets'] as const) {
      expect(Reflect.set(DEFAULT_P2, key, false)).toBe(false);
      expect(DEFAULT_P2[key]).toBe(true);
    }
    // Both surviving switches default ON (2026-10-06 product decision; the v2
    // A/B was inconclusive, see DEFAULT_P2's note).
    expect({ ...DEFAULT_P2 }).toEqual({ sizeGrid: true, buckets: true });
    // A refused mutation leaves the on-by-default semantics intact: the default
    // parameter still reads `true`, so 0.9 pot snaps to 1.0 -> value-heavy.
    expect(
      chooseVillainModel({ allIn: false, heroWasAggressor: false, wet: false, betFraction: 0.9 }),
    ).toBe('value-heavy');

    // The named kill-switch constant is the immutable all-off counterpart, no
    // longer identical to the default.
    expect(Object.isFrozen(P2_ALL_OFF)).toBe(true);
    expect({ ...P2_ALL_OFF }).toEqual({ sizeGrid: false, buckets: false });
    expect({ ...P2_ALL_OFF }).not.toEqual({ ...DEFAULT_P2 });
  });
});

// ---------------------------------------------------------------------------
// explicit all-off (P2_ALL_OFF) versus the true HEAD f4a5904 baseline, per input,
// plus proof the new on-by-default switches actually reach the decision
// ---------------------------------------------------------------------------

describe('postflop P2: explicit all-off reproduces the HEAD baseline', () => {
  const DRY = [c('Kh'), c('7d'), c('2c')];

  /** A deterministic grid that exercises every input the P0/P1 engine reads. */
  function baselineGrid(): DecisionView[] {
    const boards: CardId[][] = [
      DRY,
      [c('Th'), c('9h'), c('8h')],
      [c('5s'), c('7s'), c('9s'), c('Js'), c('2d')],
      [c('Qh'), c('Jh'), c('2c')],
    ];
    const holes: CardId[][] = [
      [c('Qs'), c('Qd')],
      [c('Ac'), c('Kd')],
      [c('7c'), c('2d')],
      [c('8s'), c('8d')],
      [c('Th'), c('Jh')],
    ];
    const sizes: readonly (readonly [number, number])[] = [
      [100, 50],
      [150, 50],
      [90, 60],
      [200, 100],
      // P1-3: potBefore = 190 - 90 = 100, so call/potBefore = 0.9 - the only raw
      // size in [0.875, 1.0) that the sizeGrid switch actually re-buckets
      // (balanced -> value-heavy). Without it the default differential grid would
      // not be sensitive to sizeGrid silently turning on.
      [190, 90],
    ];
    const out: DecisionView[] = [];
    for (const board of boards) {
      for (const hole of holes) {
        for (const [pot, call] of sizes) {
          for (const seq of [0, 1, 2]) {
            out.push(facingView([...hole], [...board], pot, call, { actionSeq: seq }));
          }
          // 3-bet line + a 10-hand opponent read (feeds the always-on opponent
          // model; the deleted `rangePropagation` is no longer an input here).
          out.push(
            facingView([...hole], [...board], pot, call, {
              actionSeq: 5,
              actionHistory: [preflopRaise(0, 0), preflopRaise(1, 1)],
              sessionMemory: memoryWith({
                seat: 0,
                sampleHands: 10,
                vpipHands: 8,
                pfrHands: 7,
                postflopBetsRaises: 12,
                postflopCalls: 4,
              }),
            }),
          );
          // Disconnect gap: partial history.
          out.push(
            facingView([...hole], [...board], pot, call, {
              actionSeq: 6,
              historyComplete: false,
              actionHistory: [preflopRaise(0, 0)],
            }),
          );
          // A large, ordinary sample (station-ish).
          out.push(
            facingView([...hole], [...board], pot, call, {
              actionSeq: 7,
              sessionMemory: memoryWith(stats(0.5, 0.2, 30)),
            }),
          );
        }
        // All-in facing bet.
        out.push(
          facingView([...hole], [...board], 200, 100, {
            actionSeq: 8,
            opponents: [seat({ seat: 0, committed: 100, total: 100, allIn: true })],
          }),
        );
        // Unopened (check/bet) decisions.
        for (const seq of [0, 1, 2, 3]) {
          out.push(unopenedView([...hole], [...board], 60, { actionSeq: seq }));
        }
      }
    }
    return out;
  }

  it(
    'the explicit P2_ALL_OFF config reproduces the HEAD f4a5904 baseline',
    { timeout: 120_000 },
    () => {
      const views = baselineGrid();
      expect(views.length).toBeGreaterThan(200);
      // The pre-P2 control is now opt-in: pass P2_ALL_OFF explicitly. The product
      // default (DEFAULT_P2) is buckets + sizeGrid ON and is checked below.
      const current = new PostflopPolicy({ params: PARAMS, seed: SEED, p2: P2_ALL_OFF });
      const baseline = new BaselinePostflopPolicy({ params: PARAMS, seed: SEED });
      for (let i = 0; i < views.length; i++) {
        const view = views[i]!;
        expect(current.decide(view), `view #${i} (${view.hand?.street ?? 'none'})`).toEqual(
          baseline.decide(view),
        );
      }
    },
  );

  it('the product default (buckets + sizeGrid on) differs from the all-off baseline', () => {
    // Behaviour-level proof that the new defaults are live: the default is NOT
    // the pre-P2 engine any more. The differential grid includes the 0.9-pot
    // size that `sizeGrid` re-buckets and boards where `buckets` reweights the
    // range, so at least one decision must move.
    const views = baselineGrid();
    const def = new PostflopPolicy({ params: PARAMS, seed: SEED }); // DEFAULT_P2
    const off = new PostflopPolicy({ params: PARAMS, seed: SEED, p2: P2_ALL_OFF });
    const defDecisions = views.map((view) => def.decide(view));
    const offDecisions = views.map((view) => off.decide(view));
    // Keep the full-decision inequality (proves the two paths are not
    // byte-identical).
    expect(
      defDecisions.some((d, i) => JSON.stringify(d) !== JSON.stringify(offDecisions[i])),
    ).toBe(true);
    // ...and pin the difference to a real ACTION change, not only a differing
    // `reason` string. Without this, a `reason`-only diff would satisfy the
    // assertion above while the chosen action never moved.
    expect(
      defDecisions.some((d, i) => d.action.type !== offDecisions[i]!.action.type),
    ).toBe(true);
    // And the default equals an explicit all-on config, byte for byte.
    const explicitOn = new PostflopPolicy({
      params: PARAMS,
      seed: SEED,
      p2: { sizeGrid: true, buckets: true },
    });
    for (const view of views) expect(def.decide(view)).toEqual(explicitOn.decide(view));
  });
});
