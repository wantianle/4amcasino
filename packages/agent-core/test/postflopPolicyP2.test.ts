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
  preflopRaiseCount,
  propagateVillainModel,
  snapBetFraction,
  type P2Options,
} from '../src/postflopPolicy.js';
import {
  OPPONENT_PRIORS,
  estimateOpponent,
  shrinkConfidence,
  shrinkRate,
} from '../src/sessionMemory.js';
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
// #2 shrinkage opponent model
// ---------------------------------------------------------------------------

describe('postflop P2: shrinkage opponent model', () => {
  it('small samples collapse toward the prior; large samples approach the frequency', () => {
    const prior = OPPONENT_PRIORS.vpip;
    // 4/5 observed: the raw 80% is far from the prior, the posterior is not.
    const small = shrinkRate(4, 5, prior);
    expect(small).toBeCloseTo((prior.strength * prior.mean + 4) / (prior.strength + 5), 12);
    expect(Math.abs(small - prior.mean)).toBeLessThan(Math.abs(small - 0.8));
    expect(Math.abs(small - prior.mean)).toBeLessThan(0.15);

    // A large sample barely moves from the raw frequency.
    const large = shrinkRate(300, 500, prior);
    expect(Math.abs(large - 0.6)).toBeLessThan(0.02);
  });

  it('converges monotonically to the observed frequency as n grows', () => {
    const prior = OPPONENT_PRIORS.pfr;
    const trueRate = 0.4;
    let previousDistance = Number.POSITIVE_INFINITY;
    for (const n of [0, 5, 20, 100, 500, 5000]) {
      const estimate = shrinkRate(trueRate * n, n, prior);
      const distance = Math.abs(estimate - trueRate);
      expect(distance, `n=${n}`).toBeLessThanOrEqual(previousDistance + 1e-12);
      previousDistance = distance;
    }
    expect(shrinkRate(trueRate * 5000, 5000, prior)).toBeCloseTo(trueRate, 2);
  });

  it('is exactly the prior at n=0 and stays in [0,1]', () => {
    for (const key of Object.keys(OPPONENT_PRIORS) as (keyof typeof OPPONENT_PRIORS)[]) {
      const prior = OPPONENT_PRIORS[key];
      expect(shrinkRate(0, 0, prior)).toBeCloseTo(prior.mean, 12);
      for (const [hits, n] of [
        [0, 3],
        [3, 3],
        [999, 1000],
      ] as const) {
        const value = shrinkRate(hits, n, prior);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    // Malformed counts fail safe rather than producing NaN.
    const safe = shrinkRate(Number.NaN, 5, OPPONENT_PRIORS.vpip);
    expect(Number.isFinite(safe)).toBe(true);
    expect(safe).toBeCloseTo(shrinkRate(0, 5, OPPONENT_PRIORS.vpip), 12);
  });

  it('honours the total input contract: k+n=0, hits>n, negatives, fractions', () => {
    const prior = OPPONENT_PRIORS.vpip;
    const noPrior: { mean: number; strength: number } = { mean: 0.3, strength: 0 };
    // No sample and no prior: undefined posterior -> neutral fallback = prior mean.
    expect(shrinkRate(0, 0, noPrior)).toBeCloseTo(0.3, 12);
    expect(shrinkRate(5, 0, noPrior)).toBeCloseTo(0.3, 12); // hits only, no trials
    expect(shrinkConfidence(0, noPrior)).toBe(0); // no information at all
    expect(shrinkConfidence(7, noPrior)).toBe(1); // no prior + sample = full trust

    // hits > n is clamped to a saturated observation, never an out-of-range rate.
    expect(shrinkRate(9, 3, noPrior)).toBe(1);
    expect(shrinkRate(9, 3, prior)).toBeCloseTo(
      (prior.strength * prior.mean + 3) / (prior.strength + 3),
      12,
    );

    // Negative / non-finite counts read as 0; fractional weighted counts are kept.
    expect(shrinkRate(-5, 10, prior)).toBeCloseTo(shrinkRate(0, 10, prior), 12);
    expect(shrinkRate(3, -1, prior)).toBeCloseTo(shrinkRate(0, 0, prior), 12);
    expect(shrinkRate(2.5, 5, prior)).toBeCloseTo(
      (prior.strength * prior.mean + 2.5) / (prior.strength + 5),
      12,
    );
    expect(shrinkRate(5, Number.POSITIVE_INFINITY, prior)).toBeCloseTo(
      shrinkRate(0, 0, prior),
      12,
    );

    // Every combination stays finite and inside [0,1].
    for (const [h, n] of [
      [Number.NaN, Number.NaN],
      [-1, -1],
      [1e9, 1],
      [0.5, 0.25],
    ] as const) {
      const v = shrinkRate(h, n, prior);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('confidence rises from 0 to 1 and is k=half at n=strength', () => {
    const prior = OPPONENT_PRIORS.vpip;
    expect(shrinkConfidence(0, prior)).toBe(0);
    expect(shrinkConfidence(prior.strength, prior)).toBeCloseTo(0.5, 12);
    expect(shrinkConfidence(1000, prior)).toBeGreaterThan(0.97);
    expect(shrinkConfidence(5, prior)).toBeLessThan(0.25);
  });

  it('estimateOpponent pairs counts with their own prior per stat', () => {
    const est = estimateOpponent({
      seat: 0,
      sampleHands: 50,
      vpipHands: 30,
      pfrHands: 5,
      postflopBetsRaises: 10,
      postflopCalls: 10,
    });
    expect(est.vpip).toBeCloseTo(shrinkRate(30, 50, OPPONENT_PRIORS.vpip), 12);
    expect(est.pfr).toBeCloseTo(shrinkRate(5, 50, OPPONENT_PRIORS.pfr), 12);
    // Aggression denominator is bet/raise + call, not sampleHands.
    expect(est.aggression).toBeCloseTo(shrinkRate(10, 20, OPPONENT_PRIORS.aggression), 12);
    expect(est.confidence).toBeCloseTo(shrinkConfidence(50, OPPONENT_PRIORS.vpip), 12);
    // No postflop actions: the aggression rate is the prior, not 0/0.
    const empty = estimateOpponent({
      seat: 0,
      sampleHands: 3,
      vpipHands: 0,
      pfrHands: 0,
      postflopBetsRaises: 0,
      postflopCalls: 0,
    });
    expect(empty.aggression).toBeCloseTo(OPPONENT_PRIORS.aggression.mean, 12);
  });

  it('opponentModelStats no longer hard-drops a 5-hand sample', () => {
    // A 2-of-5 voluntary rate: raw 40%, prior 28%; the shrunk read is ~30%.
    const view = facingView([c('Qs'), c('Qd')], [c('Kh'), c('7d'), c('2c')], 150, 50, {
      sessionMemory: memoryWith(stats(0.4, 0, 5)),
    });
    // Old path: ignored. Shrinkage path: a near-prior posterior-mean read.
    expect(opponentModelStats(view, false)).toEqual({});
    const shrunk = opponentModelStats(view, true);
    expect(shrunk.vpip).toBeDefined();
    expect(shrunk.vpip!).toBeGreaterThan(OPPONENT_PRIORS.vpip.mean);
    expect(Math.abs(shrunk.vpip! - OPPONENT_PRIORS.vpip.mean)).toBeLessThan(0.05);
  });

  it('keeps the station / nit exploit read through the posterior', () => {
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
    // Grid read: 0.9 snaps to 1.0 pot -> value-heavy. This is an intentional
    // behaviour change of the sizeGrid switch, off by default and enabled
    // explicitly here.
    expect(chooseVillainModel({ ...base, betFraction: 0.9 }, true)).toBe('value-heavy');
  });

  it('does not change the P0 size buckets for the canonical sizes', () => {
    const base = { allIn: false, heroWasAggressor: false, wet: false };
    expect(chooseVillainModel({ ...base, betFraction: 0.33 })).toBe('bluff-heavy');
    expect(chooseVillainModel({ ...base, betFraction: 0.5 })).toBe('balanced');
    expect(chooseVillainModel({ ...base, betFraction: 0.75 })).toBe('balanced');
    expect(chooseVillainModel({ ...base, betFraction: 1 })).toBe('value-heavy');
    expect(chooseVillainModel({ ...base, betFraction: 2 })).toBe('value-heavy');
    expect(chooseVillainModel({ ...base, betFraction: 0.5, allIn: true })).toBe('value-heavy');
    // The default `sizeGrid` argument follows DEFAULT_P2 (all off after the
    // 2026-10-06 A/B revert), so a single-argument call keeps the raw-continuous
    // read for the odd 0.9-pot bet.
    expect(chooseVillainModel({ ...base, betFraction: 0.9 })).toBe('balanced');
    // An explicit on snaps the odd 0.9 to 1.0 -> value-heavy.
    expect(chooseVillainModel({ ...base, betFraction: 0.9 }, true)).toBe('value-heavy');
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
    // and the `buckets` switch is off by default. It is an eval-only probe.
  });
});

// ---------------------------------------------------------------------------
// #1 range propagation
// ---------------------------------------------------------------------------

describe('postflop P2: range propagation', () => {
  const DRY = [c('Kh'), c('7d'), c('2c')];

  it('is the identity with no preflop history heads-up', () => {
    for (const base of ['bluff-heavy', 'balanced', 'value-heavy'] as const) {
      expect(
        propagateVillainModel(base, {
          preflopRaises: 0,
          heroWasAggressor: false,
          activeOpponents: 1,
        }),
      ).toBe(base);
    }
  });

  it('tightens a 3-bet pot one tier', () => {
    expect(
      propagateVillainModel('balanced', {
        preflopRaises: 2,
        heroWasAggressor: false,
        activeOpponents: 2,
      }),
    ).toBe('value-heavy');
    expect(
      propagateVillainModel('bluff-heavy', {
        preflopRaises: 3,
        heroWasAggressor: false,
        activeOpponents: 2,
      }),
    ).toBe('balanced');
  });

  it('tightens a raised multiway and a very multiway pot', () => {
    expect(
      propagateVillainModel('bluff-heavy', {
        preflopRaises: 1,
        heroWasAggressor: false,
        activeOpponents: 3,
      }),
    ).toBe('balanced');
    expect(
      propagateVillainModel('bluff-heavy', {
        preflopRaises: 0,
        heroWasAggressor: false,
        activeOpponents: 4,
      }),
    ).toBe('balanced');
    expect(
      propagateVillainModel('bluff-heavy', {
        preflopRaises: 1,
        heroWasAggressor: false,
        activeOpponents: 4,
      }),
    ).toBe('value-heavy');
  });

  it("widens a tier when hero made the last preflop raise (opponent's range is capped)", () => {
    expect(
      propagateVillainModel('value-heavy', {
        preflopRaises: 0,
        heroWasAggressor: true,
        activeOpponents: 1,
      }),
    ).toBe('balanced');
  });

  it('derives the propagation evidence from the public view', () => {
    const board = DRY;
    const hole = [c('Qs'), c('Qd')];
    const ON: P2Options = { ...DEFAULT_P2, rangePropagation: true };
    const OFF: P2Options = { ...DEFAULT_P2, rangePropagation: false };
    // Medium bet (0.5 pot) reads balanced on its own; a 3-bet line tightens it.
    const called = facingView(hole, board, 150, 50);
    const threeBet = facingView(hole, board, 150, 50, {
      actionHistory: [preflopRaise(0, 0), preflopRaise(0, 1)],
    });
    expect(preflopRaiseCount(called)).toBe(0);
    expect(preflopRaiseCount(threeBet)).toBe(2);
    expect(facingVillainModel(called, 100, 50, ON)).toBe('balanced');
    expect(facingVillainModel(threeBet, 100, 50, ON)).toBe('value-heavy');
    // The toggle off reproduces the base read; the default is all-off too
    // (2026-10-06 A/B revert), so a 3-bet line does not tighten it.
    expect(facingVillainModel(threeBet, 100, 50, OFF)).toBe('balanced');
    expect(facingVillainModel(threeBet, 100, 50)).toBe('balanced');
  });

  it('tightens a four-way pot relative to heads-up for the same bet', () => {
    const hole = [c('Qs'), c('Qd')];
    const ON: P2Options = { ...DEFAULT_P2, rangePropagation: true };
    const headsUp = facingView(hole, DRY, 150, 50);
    const fourWay = facingView(hole, DRY, 150, 50, {
      opponents: [
        seat({ seat: 0, committed: 50, total: 50 }),
        seat({ seat: 2, committed: 50, total: 50 }),
        seat({ seat: 3, committed: 50, total: 50 }),
        seat({ seat: 4, committed: 50, total: 50 }),
      ],
    });
    expect(facingVillainModel(headsUp, 100, 50, ON)).toBe('balanced');
    expect(facingVillainModel(fourWay, 100, 50, ON)).toBe('value-heavy');
    // Inert by default (all-off after the 2026-10-06 A/B revert), so the same
    // inputs read balanced with DEFAULT_P2.
    expect(facingVillainModel(fourWay, 100, 50)).toBe('balanced');
  });

  // -- historyComplete contract (disconnect gap / mid-hand join) --------------

  it('refuses to propagate a 3-bet line from an incomplete history', () => {
    const hole = [c('Qs'), c('Qd')];
    const complete = facingView(hole, DRY, 150, 50, {
      historyComplete: true,
      actionHistory: [preflopRaise(0, 0), preflopRaise(0, 1)],
    });
    const partial: DecisionView = { ...complete, historyComplete: false };
    const on: P2Options = { ...DEFAULT_P2, rangePropagation: true };
    // With reliable history the line tightens the model...
    expect(facingVillainModel(complete, 100, 50, on)).toBe('value-heavy');
    // ...but a partial history keeps the size-only base read.
    expect(facingVillainModel(partial, 100, 50, on)).toBe('balanced');
    // The count itself refuses to read a partial history as "no raise".
    expect(preflopRaiseCount(complete)).toBe(2);
    expect(preflopRaiseCount(partial)).toBe(0);
  });

  it('ignores the action line for a mid-hand join even when the snapshot looks multiway', () => {
    // historyComplete=false, no history replayed, but 4 active opponents. Without
    // the gate the "very multiway" rule would tighten to value-heavy; the gate
    // must keep the base read because the line is unknown.
    const hole = [c('Qs'), c('Qd')];
    const joined = facingView(hole, DRY, 150, 50, {
      historyComplete: false,
      actionHistory: [],
      opponents: [
        seat({ seat: 0, committed: 50, total: 50 }),
        seat({ seat: 2, committed: 50, total: 50 }),
        seat({ seat: 3, committed: 50, total: 50 }),
        seat({ seat: 4, committed: 50, total: 50 }),
      ],
    });
    const on: P2Options = { ...DEFAULT_P2, rangePropagation: true };
    expect(facingVillainModel(joined, 100, 50, on)).toBe('balanced');
    // Sanity: the same shape with a complete history does tighten.
    const complete: DecisionView = { ...joined, historyComplete: true };
    expect(facingVillainModel(complete, 100, 50, on)).toBe('value-heavy');
  });
});

// ---------------------------------------------------------------------------
// toggles / decision-level on-vs-off / integration / legality
// ---------------------------------------------------------------------------

describe('postflop P2: decision-level on-vs-off', () => {
  const DRY = [c('Kh'), c('7d'), c('2c')];
  // A 10-hand maniac: the legacy path keeps all 10 hands, the shrunk read pulls
  // the rates back toward the priors and stops classifying a maniac.
  const maniac: OpponentStats = {
    seat: 0,
    sampleHands: 10,
    vpipHands: 8,
    pfrHands: 7,
    postflopBetsRaises: 12,
    postflopCalls: 4,
  };
  const OFF: P2Options = {
    shrinkage: false,
    sizeGrid: false,
    rangePropagation: false,
    buckets: false,
  };

  it('shrinkage changes the villain model, equity and the action rate', () => {
    // 98 on K72 facing half pot: a marginal call at the decision boundary.
    const view = (seq: number) =>
      facingView([c('9s'), c('8d')], DRY, 150, 50, {
        actionSeq: seq,
        sessionMemory: memoryWith(maniac),
      });
    expect(facingVillainModel(view(0), 100, 50, OFF)).toBe('bluff-heavy');
    expect(facingVillainModel(view(0), 100, 50, { ...OFF, shrinkage: true })).toBe('balanced');

    const rangeOff = facingVillainRange(view(0), [c('9s'), c('8d')], 100, 50, OFF);
    const rangeOn = facingVillainRange(view(0), [c('9s'), c('8d')], 100, 50, {
      ...OFF,
      shrinkage: true,
    });
    const eqOff = estimateEquity({
      hole: [c('9s'), c('8d')],
      board: DRY,
      samples: 512,
      seed: 1,
      villainRange: rangeOff,
    }).equity;
    const eqOn = estimateEquity({
      hole: [c('9s'), c('8d')],
      board: DRY,
      samples: 512,
      seed: 1,
      villainRange: rangeOn,
    }).equity;
    expect(eqOn).not.toBe(eqOff);

    const offCounts = actionCounts(policy(OFF), view);
    const onCounts = actionCounts(policy({ ...OFF, shrinkage: true }), view);
    expect(onCounts).not.toEqual(offCounts);
    // The maniac read widens the villain range, so the shrunk (balanced) read
    // folds this marginal hand more, not less.
    expect(onCounts.fold ?? 0).toBeGreaterThan(offCounts.fold ?? 0);
  });

  it('sizeGrid changes the villain model, range weights and the action rate', () => {
    // call/potBefore = 90/100 = 0.9 pot: raw-continuous reads balanced, the grid
    // snaps it to 1.0 pot and reads value-heavy.
    const view = (seq: number) =>
      facingView([c('3s'), c('3d')], [c('Kh'), c('9c'), c('4d')], 190, 90, { actionSeq: seq });
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

  it('rangePropagation shifts the model and the action rate on a 3-bet line', () => {
    const view = (seq: number) =>
      facingView([c('3s'), c('3d')], DRY, 150, 50, {
        actionSeq: seq,
        actionHistory: [preflopRaise(0, 0), preflopRaise(0, 1)],
      });
    expect(facingVillainModel(view(0), 100, 50, OFF)).toBe('balanced');
    expect(facingVillainModel(view(0), 100, 50, { ...OFF, rangePropagation: true })).toBe(
      'value-heavy',
    );
    const offCounts = actionCounts(policy(OFF), view);
    const onCounts = actionCounts(policy({ ...OFF, rangePropagation: true }), view);
    expect(onCounts).not.toEqual(offCounts);
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
      { shrinkage: false, sizeGrid: false, rangePropagation: false },
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

  it('DEFAULT_P2 is frozen all-off: the default cannot be mutated at runtime (P0-2)', () => {
    // The constant must not be a mutable object that default parameters alias,
    // or `DEFAULT_P2.sizeGrid = true` would silently flip every default read.
    expect(Object.isFrozen(DEFAULT_P2)).toBe(true);
    for (const key of ['shrinkage', 'sizeGrid', 'rangePropagation', 'buckets'] as const) {
      expect(Reflect.set(DEFAULT_P2, key, true)).toBe(false);
      expect(DEFAULT_P2[key]).toBe(false);
    }
    // All four switches are off again after the 2026-10-06 A/B revert.
    expect({ ...DEFAULT_P2 }).toEqual({
      shrinkage: false,
      sizeGrid: false,
      rangePropagation: false,
      buckets: false,
    });
    // A refused mutation leaves the all-off semantics intact: the default
    // parameter still reads `false`, so 0.9 pot stays on the raw-continuous path.
    expect(
      chooseVillainModel({ allIn: false, heroWasAggressor: false, wet: false, betFraction: 0.9 }),
    ).toBe('balanced');

    // The named kill-switch constant is the immutable all-off counterpart; since
    // the A/B revert it is byte-identical to the default.
    expect(Object.isFrozen(P2_ALL_OFF)).toBe(true);
    expect({ ...P2_ALL_OFF }).toEqual({
      shrinkage: false,
      sizeGrid: false,
      rangePropagation: false,
      buckets: false,
    });
    expect({ ...P2_ALL_OFF }).toEqual({ ...DEFAULT_P2 });
  });
});

// ---------------------------------------------------------------------------
// default (all-off, reverted) versus the true HEAD f4a5904 baseline, per input
// ---------------------------------------------------------------------------

describe('postflop P2: default all-off reproduces the HEAD baseline', () => {
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
          // 3-bet line + a 10-hand maniac read (shrinkage / propagation inputs).
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
    'the default (all-off) config reproduces the HEAD f4a5904 baseline',
    { timeout: 120_000 },
    () => {
      const views = baselineGrid();
      expect(views.length).toBeGreaterThan(200);
      const current = new PostflopPolicy({ params: PARAMS, seed: SEED }); // DEFAULT_P2: all off
      const baseline = new BaselinePostflopPolicy({ params: PARAMS, seed: SEED });
      for (let i = 0; i < views.length; i++) {
        const view = views[i]!;
        expect(current.decide(view), `view #${i} (${view.hand?.street ?? 'none'})`).toEqual(
          baseline.decide(view),
        );
      }
    },
  );

  it('an explicit P2_ALL_OFF config equals the default all-off config', () => {
    const views = baselineGrid().slice(0, 120);
    const def = new PostflopPolicy({ params: PARAMS, seed: SEED }); // DEFAULT_P2: all off
    const explicit = new PostflopPolicy({ params: PARAMS, seed: SEED, p2: P2_ALL_OFF });
    for (const view of views) expect(def.decide(view)).toEqual(explicit.decide(view));
  });

  it('an explicit all-on config is live and differs from the default all-off path', () => {
    const views = baselineGrid();
    const def = new PostflopPolicy({ params: PARAMS, seed: SEED }); // DEFAULT_P2: all off
    const allOn = new PostflopPolicy({
      params: PARAMS,
      seed: SEED,
      p2: { shrinkage: true, sizeGrid: true, rangePropagation: true, buckets: true },
    });
    // Decisive evidence that the four switches actually reach the decision when
    // enabled, so "default is all-off" is not a claim that P2 is unreachable.
    expect(
      views.some(
        (view) => JSON.stringify(def.decide(view)) !== JSON.stringify(allOn.decide(view)),
      ),
    ).toBe(true);
  });
});
