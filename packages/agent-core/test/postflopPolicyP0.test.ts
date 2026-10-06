import { describe, expect, it } from 'vitest';
import { cardFromName, type CardId } from '@4am/shared';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionPotOdds,
  DecisionSeat,
  DecisionView,
  OpponentStats,
} from '../src/decisionView.js';
import { estimateEquity } from '../src/equity.js';
import {
  P0_EQUITY_SAMPLES,
  P0_MULTIWAY_EQUITY_SAMPLES,
  P2_ALL_OFF,
  PostflopPolicy,
  buildVillainRange,
  chooseVillainModel,
  facingBetMargin,
  facingBetSamples,
  facingVillainModel,
  facingVillainRange,
  resolveFacingBetPrice,
  villainModelWeight,
  type VillainRangeModel,
} from '../src/postflopPolicy.js';
import { deriveRulesSeed } from '../src/rulesSeed.js';
import { RULE_PRESETS } from '../src/ruleStyles.js';

const c = (n: string) => cardFromName(n);
const SEED = 7;
// P0 behaviour is locked with P2 explicitly off (the default since the
// 2026-10-06 A/B revert); the explicit constant keeps the isolation explicit.
const policy = () =>
  new PostflopPolicy({ params: RULE_PRESETS['tight-aggressive'], seed: SEED, p2: P2_ALL_OFF });

// ---------------------------------------------------------------------------
// view builders
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
  over: Partial<DecisionView> = {},
  opts: { allIn?: boolean } = {},
): DecisionView {
  const villain = seat({
    seat: 0,
    committed: call,
    total: call,
    allIn: opts.allIn ?? false,
  });
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
    actionSeq: 0,
    ...over,
  };
}

function stats(vpip: number, pfr: number, aggression: number, calls: number): OpponentStats {
  return {
    seat: 0,
    sampleHands: 50,
    vpipHands: Math.round(vpip * 50),
    pfrHands: Math.round(pfr * 50),
    postflopBetsRaises: Math.round(aggression * 50),
    postflopCalls: calls,
  };
}

function memoryWith(...opponents: OpponentStats[]): DecisionView['sessionMemory'] {
  return { handsObserved: 50, netChips: null, recentHands: [], opponents };
}

/** Count non-fold decisions over `n` seeds for a view factory. */
function callRate(factory: (seq: number) => DecisionView, p: PostflopPolicy, n = 160): number {
  let calls = 0;
  for (let seq = 0; seq < n; seq++) {
    if (p.decide(factory(seq)).action.type !== 'fold') calls++;
  }
  return calls / n;
}

/**
 * The exact equity AND error-matched margin the P0 decision uses for a view
 * (same seed / samples / range / band helpers).
 */
function policyEquity(view: DecisionView): { equity: number; margin: number; required: number } {
  const hole = view.hand!.myCards;
  const board = view.hand!.board;
  const call = view.legalActions!.callAmount;
  const pot = view.potOdds?.pot ?? 0;
  const potBefore = Math.max(0, pot - call);
  const active = Math.max(1, view.opponents.filter((o) => !o.folded).length);
  const samples = facingBetSamples(active);
  const equity = estimateEquity({
    hole,
    board,
    opponents: active,
    samples,
    seed: deriveRulesSeed(SEED, view),
    villainRange: facingVillainRange(view, hole, potBefore, call),
  }).equity;
  return { equity, margin: facingBetMargin(equity, samples), required: view.potOdds!.potOdds };
}

// ---------------------------------------------------------------------------

describe('postflop P0: resolveFacingBetPrice (pure)', () => {
  const valid = (over: Partial<DecisionPotOdds> = {}): DecisionPotOdds => ({
    callAmount: 50,
    pot: 100,
    potOdds: 50 / 150,
    breakEvenEquity: 50 / 150,
    ...over,
  });

  it('trusts a consistent snapshot and derives potBefore/MDF', () => {
    const price = resolveFacingBetPrice(valid(), 50);
    expect(price.trusted).toBe(true);
    expect(price.potBefore).toBe(50);
    expect(price.derivedOdds).toBeCloseTo(50 / 150, 12);
    expect(price.requiredEquity).toBeCloseTo(50 / 150, 12);
    expect(price.requiredMdf).toBeCloseTo(0.5, 12); // mdf(50, 50)
  });

  it('rejects a null/undefined snapshot', () => {
    for (const value of [null, undefined]) {
      const price = resolveFacingBetPrice(value, 50);
      expect(price.trusted).toBe(false);
      expect(price.potBefore).toBe(0);
      expect(price.requiredMdf).toBe(0.5);
    }
  });

  it('rejects an unusable pot and never silently corrects pot < call', () => {
    for (const pot of [Number.NaN, Number.POSITIVE_INFINITY, -1, 40]) {
      const price = resolveFacingBetPrice(valid({ pot }), 50);
      expect(price.trusted, `pot=${pot}`).toBe(false);
      expect(price.potBefore, `pot=${pot}`).toBe(0); // not max(0, pot - call)
      expect(price.requiredMdf, `pot=${pot}`).toBe(0.5);
    }
    // pot === call is legal (zero pot before the bet).
    expect(resolveFacingBetPrice(valid({ pot: 50, potOdds: 50 / 100, breakEvenEquity: 50 / 100 }), 50).trusted).toBe(
      true,
    );
  });

  it('requires potOdds.callAmount to equal the legal call amount', () => {
    expect(resolveFacingBetPrice(valid({ callAmount: 50 }), 50).trusted).toBe(true);
    for (const callAmount of [49, 51, Number.NaN, -1]) {
      expect(resolveFacingBetPrice(valid({ callAmount }), 50).trusted, `callAmount=${callAmount}`).toBe(false);
    }
  });

  it('rejects malformed / inconsistent potOdds and breakEvenEquity', () => {
    const good = 50 / 150;
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1, good + 0.01]) {
      expect(resolveFacingBetPrice(valid({ potOdds: value }), 50).trusted, `potOdds=${value}`).toBe(false);
      expect(
        resolveFacingBetPrice(valid({ breakEvenEquity: value }), 50).trusted,
        `breakEvenEquity=${value}`,
      ).toBe(false);
    }
    // Contract says breakEvenEquity === potOdds: breaking only that must fail.
    expect(resolveFacingBetPrice(valid({ breakEvenEquity: 0.5 }), 50).trusted).toBe(false);
    // Each field within tolerance of the derived odds, but apart from each
    // other by more than the tolerance: still untrusted.
    const d = 50 / 150;
    expect(
      resolveFacingBetPrice(
        { callAmount: 50, pot: 100, potOdds: d + 9.9e-7, breakEvenEquity: d - 9.9e-7 },
        50,
      ).trusted,
    ).toBe(false);
    // The contract is strict equality: even a sub-epsilon difference between
    // two individually-tolerated fields must stay untrusted.
    expect(
      resolveFacingBetPrice(
        { callAmount: 50, pot: 100, potOdds: d + 5e-7, breakEvenEquity: d },
        50,
      ).trusted,
    ).toBe(false);
    expect(
      resolveFacingBetPrice(
        { callAmount: 50, pot: 100, potOdds: d, breakEvenEquity: d - 5e-7 },
        50,
      ).trusted,
    ).toBe(false);
  });

  it('rejects a non-finite / negative legal call amount', () => {
    for (const call of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(resolveFacingBetPrice(valid(), call).trusted, `call=${call}`).toBe(false);
    }
  });

  it('handles a consistent zero-call snapshot', () => {
    const price = resolveFacingBetPrice(
      { callAmount: 0, pot: 100, potOdds: 0, breakEvenEquity: 0 },
      0,
    );
    expect(price.trusted).toBe(true);
    expect(price.derivedOdds).toBe(0);
    expect(price.requiredMdf).toBe(1); // mdf(100, 0)
  });
});

describe('postflop P0: villain range model', () => {
  const station = { opponentVpip: 0.6, opponentPfr: 0.1, opponentAggression: 0.2 };
  const nit = { opponentVpip: 0.15, opponentPfr: 0.1, opponentAggression: 0.2 };
  const maniac = { opponentVpip: 0.7, opponentPfr: 0.5, opponentAggression: 0.6 };

  // The complete bet dimension: all-in is size-independent and checked first.
  const bets = [
    { name: 'all-in', allIn: true, betFraction: 1 },
    { name: 'large', allIn: false, betFraction: 2 },
    { name: 'medium', allIn: false, betFraction: 0.5 },
    { name: 'small', allIn: false, betFraction: 0.33 },
  ] as const;

  // Explicit per-cell expectation for a read-less ("normal") opponent.
  // Key: `${texture}-${initiative}-${bet}`.
  const NORMAL_EXPECTED: Record<string, VillainRangeModel> = {
    'dry-passive-all-in': 'value-heavy',
    'dry-passive-large': 'value-heavy',
    'dry-passive-medium': 'balanced',
    'dry-passive-small': 'bluff-heavy',
    'wet-passive-all-in': 'value-heavy',
    'wet-passive-large': 'value-heavy',
    'wet-passive-medium': 'balanced',
    'wet-passive-small': 'bluff-heavy',
    'dry-agg-all-in': 'value-heavy',
    'dry-agg-large': 'value-heavy',
    'dry-agg-medium': 'balanced',
    'dry-agg-small': 'bluff-heavy',
    // A wet board plus hero's initiative shades a large bet back to balanced
    // and pushes a medium bet all the way to bluff-heavy.
    'wet-agg-all-in': 'value-heavy',
    'wet-agg-large': 'balanced',
    'wet-agg-medium': 'bluff-heavy',
    'wet-agg-small': 'bluff-heavy',
  };

  it('complete dry/wet × all-in/large/medium/small × opponent-type matrix', () => {
    for (const wet of [false, true]) {
      for (const heroWasAggressor of [false, true]) {
        for (const bet of bets) {
          const surface = `${wet ? 'wet' : 'dry'}-${heroWasAggressor ? 'agg' : 'passive'}`;
          const common = {
            wet,
            heroWasAggressor,
            allIn: bet.allIn,
            betFraction: bet.betFraction,
          };
          expect(
            chooseVillainModel(common),
            `${surface} ${bet.name} (no read)`,
          ).toBe(NORMAL_EXPECTED[`${surface}-${bet.name}`]);
          // A maniac is bluff-heavy at every size / texture / initiative.
          expect(
            chooseVillainModel({ ...common, ...maniac }),
            `${surface} ${bet.name} (maniac)`,
          ).toBe('bluff-heavy');
          // A station / nit is value-heavy at every size / texture / initiative.
          expect(
            chooseVillainModel({ ...common, ...station }),
            `${surface} ${bet.name} (station)`,
          ).toBe('value-heavy');
          expect(
            chooseVillainModel({ ...common, ...nit }),
            `${surface} ${bet.name} (nit)`,
          ).toBe('value-heavy');
        }
      }
    }
  });

  it('weights strong tiers above weak ones, and bluff-heavy the other way', () => {
    for (const model of ['value-heavy', 'balanced'] as const) {
      expect(villainModelWeight(1, model)).toBeGreaterThan(villainModelWeight(0.4, model));
      expect(villainModelWeight(0.4, model)).toBeGreaterThan(villainModelWeight(0.05, model));
    }
    expect(villainModelWeight(0.05, 'bluff-heavy')).toBeGreaterThan(
      villainModelWeight(1, 'bluff-heavy'),
    );
  });

  it('derives the model from a real view: dry maniac, small station and nit', () => {
    const dry = [c('Kh'), c('7d'), c('2c')];
    const hole = [c('Qs'), c('Qd')];
    // Dry-board maniac all-in: was 'balanced' before the model fix.
    const maniacView = facingView(hole, dry, 200, 100, {
      sessionMemory: memoryWith(stats(0.7, 0.5, 0.6, 5)),
    }, { allIn: true });
    expect(facingVillainModel(maniacView, 100, 100)).toBe('bluff-heavy');
    // Small bet (40 into 100 => 0.4 pot) by a station / nit is value-heavy.
    const small = (memory: DecisionView['sessionMemory']) =>
      facingView(hole, dry, 140, 40, { sessionMemory: memory });
    expect(facingVillainModel(small(memoryWith(stats(0.6, 0.1, 0.2, 5))), 100, 40)).toBe('value-heavy');
    expect(facingVillainModel(small(memoryWith(stats(0.15, 0.1, 0.2, 5))), 100, 40)).toBe('value-heavy');
  });
});

describe('postflop P0: river four-flush vs all-in (user case a)', () => {
  const board = [c('5s'), c('7s'), c('9s'), c('Js'), c('2d')];
  const lowFlush = [c('3s'), c('8d')];
  const river = (over: Partial<DecisionView> = {}, seq = 0) =>
    facingView(lowFlush, board, 200, 100, { ...over, actionSeq: seq }, { allIn: true });

  it('assigns value-heavy to a big no-read all-in and bluff-heavy to a maniac shove', () => {
    expect(facingVillainModel(river(), 100, 100)).toBe('value-heavy');
    const maniac = river({ sessionMemory: memoryWith(stats(0.7, 0.5, 0.6, 5)) });
    expect(facingVillainModel(maniac, 100, 100)).toBe('bluff-heavy');
  });

  it('folds a low flush against a value-heavy all-in, but calls a bluff-heavy shove', () => {
    const p = policy();
    const valueCallRate = callRate((seq) => river({}, seq), p);
    const bluffCallRate = callRate(
      (seq) => river({ sessionMemory: memoryWith(stats(0.7, 0.5, 0.6, 5)) }, seq),
      p,
    );
    expect(valueCallRate).toBeLessThan(0.3); // was ~0.97 under the old MDF path
    expect(bluffCallRate).toBeGreaterThan(0.6);
    expect(bluffCallRate).toBeGreaterThan(valueCallRate + 0.3);
  });
});

describe('postflop P0: turn three-flush with KK (user case b)', () => {
  const board = [c('Qh'), c('9h'), c('4h'), c('2c')];
  const noHeart = [c('Ks'), c('Kd')];
  const withHeart = [c('Kh'), c('Kd')];
  // A 2x-pot overbet: pot odds 0.4.
  const turn = (hole: CardId[], seq: number) =>
    facingView(hole, board, 300, 200, { actionSeq: seq });

  it('folds KK without a heart, and calls/raises far more with the heart blocker', () => {
    const p = policy();
    const n = 240;
    let noHeartCalls = 0;
    let withHeartNonFold = 0;
    let withHeartRaises = 0;
    for (let seq = 0; seq < n; seq++) {
      if (p.decide(turn(noHeart, seq)).action.type !== 'fold') noHeartCalls++;
      const action = p.decide(turn(withHeart, seq)).action.type;
      if (action !== 'fold') withHeartNonFold++;
      if (action === 'raise') withHeartRaises++;
    }
    const noHeartCallRate = noHeartCalls / n;
    expect(noHeartCallRate).toBeLessThan(0.35);
    expect(withHeartNonFold / n).toBeGreaterThan(0.7);
    expect(withHeartNonFold / n).toBeGreaterThan(noHeartCallRate + 0.3);
    // The heart blocker must not merely avoid folding - a hand with a live
    // flush blocker should also raise for value/semi-bluff with real frequency.
    expect(withHeartRaises / n).toBeGreaterThan(0.1);
  });
});

describe('postflop P0: flush-strength monotonicity', () => {
  const board = [c('5s'), c('7s'), c('9s'), c('Js'), c('2d')];

  const equityOf = (spade: string): number => {
    const hole = [c(spade), c('8d')];
    return estimateEquity({
      hole,
      board,
      opponents: 1,
      samples: 1500,
      seed: 5,
      villainRange: { combos: buildVillainRange(hole, board, 'balanced') },
    }).equity;
  };

  it('large-sample model equity is strictly ordered nut > middle > low', () => {
    const nut = equityOf('As');
    const middle = equityOf('Ts');
    const low = equityOf('3s');
    expect(nut).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(low);
  });

  it("the policy's own sampled equity keeps that ordering at a minimum pass rate", () => {
    const n = 40;
    let nutOverMid = 0;
    let midOverLow = 0;
    let minNut = Number.POSITIVE_INFINITY;
    for (let seq = 0; seq < n; seq++) {
      const eq = ['As', 'Ts', '3s'].map(
        (spade) =>
          policyEquity(facingView([c(spade), c('8d')], board, 200, 100, { actionSeq: seq })).equity,
      );
      if (eq[0]! > eq[1]!) nutOverMid++;
      if (eq[1]! > eq[2]!) midOverLow++;
      minNut = Math.min(minNut, eq[0]!);
    }
    // Even with the policy's limited sample budget the ordering survives; the
    // pass rate is the honest statement of residual sampling noise.
    expect(nutOverMid / n).toBeGreaterThanOrEqual(0.9);
    expect(midOverLow / n).toBeGreaterThanOrEqual(0.9);
    expect(minNut).toBeGreaterThan(0.5);
  });

  it('multiway (3 active, real 64-sample budget) also keeps the ordering', () => {
    // Multiway is a separate, coarser path: `facingBetSamples(3)` is 64, not the
    // heads-up 128. This asserts the stronger hand is never the sampled loser
    // above an explicit pass-rate floor using ONLY the policy's own budget.
    expect(facingBetSamples(3)).toBe(64);
    const n = 40;
    const villains = [seat({ seat: 2 }), seat({ seat: 3 }), seat({ seat: 4 })];
    let nutOverMid = 0;
    let midOverLow = 0;
    let minNut = Number.POSITIVE_INFINITY;
    for (let seq = 0; seq < n; seq++) {
      const eq = ['As', 'Ts', '3s'].map((spade) => {
        const view = facingView([c(spade), c('8d')], board, 200, 100, {
          actionSeq: seq,
          opponents: villains,
        });
        return policyEquity(view).equity;
      });
      if (eq[0]! > eq[1]!) nutOverMid++;
      if (eq[1]! > eq[2]!) midOverLow++;
      minNut = Math.min(minNut, eq[0]!);
    }
    expect(nutOverMid / n).toBeGreaterThanOrEqual(0.9);
    expect(midOverLow / n).toBeGreaterThanOrEqual(0.8);
    expect(minNut).toBeGreaterThan(0.8);
  });
});

describe('postflop P0: equity/pot-odds continuity', () => {
  const dry = [c('Kh'), c('7d'), c('2c')];
  const river4 = [c('5s'), c('7s'), c('9s'), c('Js'), c('2d')];

  it('never folds when equity clears pot odds (and never calls when clearly short)', () => {
    const p = policy();
    const views: DecisionView[] = [
      // old bug: low flush vs a value-heavy all-in must fold (equity short)
      facingView([c('3s'), c('8d')], river4, 200, 100, {}, { allIn: true }),
      // nut flush: equity is maxed, must never fold
      facingView([c('As'), c('Kd')], river4, 200, 100, {}, { allIn: true }),
      // KK no heart vs a 2x overbet: equity short of 0.4, must fold
      facingView([c('Ks'), c('Kd')], [c('Qh'), c('9h'), c('4h'), c('2c')], 300, 200),
      // set of kings on a dry board at half pot: equity clears, must not fold
      facingView([c('Kc'), c('Kd')], dry, 100, 50),
      // unpaired trash at half pot: equity short, must fold
      facingView([c('8s'), c('3d')], dry, 100, 50),
    ];
    let above = 0;
    let below = 0;
    for (const v of views) {
      const { equity, margin, required } = policyEquity(v);
      const action = p.decide(v).action.type;
      if (equity > required + margin) {
        above++;
        expect(action).not.toBe('fold');
      } else if (equity < required - margin) {
        below++;
        expect(action).toBe('fold');
      }
    }
    // Both branches must actually be exercised for the test to mean anything.
    expect(above).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(0);
  });

  it('regression: a hand with high equity is not folded on the old uniform-MDF short circuit', () => {
    // Under the old code the defence frequency ignored the actual hand and a
    // value-heavy range; a nut hand could still be randomised into a fold at a
    // low percentile. With P0 the nut flush always defends.
    const p = policy();
    const nut = [c('As'), c('Kd')];
    let folds = 0;
    for (let seq = 0; seq < 200; seq++) {
      if (p.decide(facingView(nut, river4, 500, 400, { actionSeq: seq })).action.type === 'fold')
        folds++;
    }
    expect(folds).toBe(0);
  });
});

describe('postflop P0: reproducibility', () => {
  const board = [c('Qh'), c('9h'), c('4h'), c('2c')];
  const view = () => facingView([c('Ks'), c('Kd')], board, 200, 100, { actionSeq: 3 });

  it('same view + seed decides identically', () => {
    const p = policy();
    const first = p.decide(view());
    for (let i = 0; i < 200; i++) expect(p.decide(view())).toEqual(first);
    // The range prior itself is deterministic too.
    const hole = view().hand!.myCards;
    expect(buildVillainRange(hole, board, 'balanced')).toEqual(
      buildVillainRange(hole, board, 'balanced'),
    );
  });

  it('different actionSeq seeds mix inside the boundary band', () => {
    const p = policy();
    const seen = new Set<string>();
    for (let seq = 0; seq < 300; seq++) {
      seen.add(p.decide(facingView([c('Ks'), c('Kd')], board, 200, 100, { actionSeq: seq })).action.type);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('postflop P0: legality of the range path', () => {
  it('returns legal actions for strong/weak/bluff-weighted views', () => {
    const p = policy();
    const board = [c('Qh'), c('9h'), c('4h'), c('2c')];
    const legals: DecisionLegalActions[] = [
      { canCheck: false, canCall: true, callAmount: 200, canBet: false, canRaise: true, minRaiseTo: 400, maxRaiseTo: 1000 },
      { canCheck: false, canCall: true, callAmount: 200, canBet: false, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0 },
    ];
    for (const legal of legals) {
      for (const hole of [[c('Kh'), c('Kd')], [c('3s'), c('2s')]] as CardId[][]) {
        for (const memory of [memoryWith(), memoryWith(stats(0.7, 0.5, 0.8, 2))]) {
          const v = facingView(hole, board, 300, 200, {
            actionSeq: 1,
            legalActions: legal,
            sessionMemory: memory,
          });
          const d = p.decide(v);
          if (d.action.type === 'fold' || d.action.type === 'call') continue;
          if (d.action.type === 'raise') {
            expect(legal.canRaise).toBe(true);
            expect(d.action.amount).toBeGreaterThanOrEqual(legal.minRaiseTo);
            expect(d.action.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
          } else {
            throw new Error(`unexpected action ${d.action.type}`);
          }
        }
      }
    }
    // Sanity: the estimate itself is finite.
    const v = facingView([c('Kh'), c('Kd')], board, 300, 200);
    expect(Number.isFinite(policyEquity(v).equity)).toBe(true);
  });
});

describe('postflop P0: sample budget and error-matched band', () => {
  it('spends the full budget heads-up and the base budget multiway', () => {
    expect(facingBetSamples(1)).toBe(P0_EQUITY_SAMPLES);
    expect(facingBetSamples(2)).toBe(P0_MULTIWAY_EQUITY_SAMPLES);
    expect(facingBetSamples(8)).toBe(P0_MULTIWAY_EQUITY_SAMPLES);
    expect(P0_MULTIWAY_EQUITY_SAMPLES).toBeLessThan(P0_EQUITY_SAMPLES);
  });

  it('band is at least the sampling standard error (the old 5% was not)', () => {
    const seMultiway = Math.sqrt(0.25 / P0_MULTIWAY_EQUITY_SAMPLES); // 6.25%
    expect(seMultiway).toBeGreaterThan(0.05); // documents the original mismatch
    expect(facingBetMargin(0.5, P0_MULTIWAY_EQUITY_SAMPLES)).toBeGreaterThanOrEqual(seMultiway);
    const seHeadsUp = Math.sqrt(0.25 / P0_EQUITY_SAMPLES);
    expect(facingBetMargin(0.5, P0_EQUITY_SAMPLES)).toBeGreaterThanOrEqual(seHeadsUp);
  });

  it('a clear edge never flips to a fold across seeds; a marginal hand mixes', () => {
    const p = policy();
    const dry = [c('Kh'), c('7d'), c('2c')];

    // Set of kings getting 2:1: the point estimate is far above the price, so
    // no seed may flip it into a fold.
    let clearFolds = 0;
    for (let seq = 0; seq < 80; seq++) {
      if (p.decide(facingView([c('Kc'), c('Kd')], dry, 100, 50, { actionSeq: seq })).action.type === 'fold')
        clearFolds++;
    }
    expect(clearFolds).toBe(0);

    // Two overcards: the estimate sits inside the band, so the MDF/percentile
    // mix - not sampling noise - decides. Both actions must appear.
    const mixed = new Set<string>();
    for (let seq = 0; seq < 200; seq++) {
      mixed.add(p.decide(facingView([c('Qs'), c('Jd')], dry, 100, 50, { actionSeq: seq })).action.type);
    }
    expect(mixed.size).toBeGreaterThan(1);
  });
});

describe('postflop P0: malformed price is conservative-neutral', () => {
  const dry = [c('Kh'), c('7d'), c('2c')];
  const strong = [c('Kc'), c('Kd')];
  const air = [c('8s'), c('3d')];
  const good = 50 / 150;
  const badSnapshots: { name: string; potOdds: DecisionPotOdds }[] = [
    { name: 'potOdds NaN', potOdds: { callAmount: 50, pot: 100, potOdds: Number.NaN, breakEvenEquity: good } },
    {
      name: 'potOdds Infinity',
      potOdds: { callAmount: 50, pot: 100, potOdds: Number.POSITIVE_INFINITY, breakEvenEquity: good },
    },
    { name: 'potOdds negative', potOdds: { callAmount: 50, pot: 100, potOdds: -0.5, breakEvenEquity: good } },
    { name: 'potOdds above one', potOdds: { callAmount: 50, pot: 100, potOdds: 1.5, breakEvenEquity: good } },
    { name: 'potOdds inconsistent', potOdds: { callAmount: 50, pot: 100, potOdds: 0.9, breakEvenEquity: 0.9 } },
    { name: 'breakEven NaN', potOdds: { callAmount: 50, pot: 100, potOdds: good, breakEvenEquity: Number.NaN } },
    { name: 'breakEven inconsistent', potOdds: { callAmount: 50, pot: 100, potOdds: good, breakEvenEquity: 0.8 } },
    { name: 'callAmount mismatch', potOdds: { callAmount: 60, pot: 100, potOdds: good, breakEvenEquity: good } },
    { name: 'pot below call', potOdds: { callAmount: 50, pot: 40, potOdds: good, breakEvenEquity: good } },
    {
      name: 'pot NaN',
      potOdds: { callAmount: 50, pot: Number.NaN, potOdds: Number.NaN, breakEvenEquity: Number.NaN },
    },
  ];

  it('never folds a strong hand because the potOdds mirror is unusable', () => {
    const p = policy();
    for (const bad of badSnapshots) {
      expect(resolveFacingBetPrice(bad.potOdds, 50).trusted, `${bad.name} should be untrusted`).toBe(false);
      const view = facingView(strong, dry, 100, 50, { potOdds: bad.potOdds });
      let folds = 0;
      for (let seq = 0; seq < 60; seq++) {
        if (p.decide({ ...view, actionSeq: seq }).action.type === 'fold') folds++;
      }
      expect(folds, `${bad.name} must not force a fold`).toBe(0);
    }
  });

  it('stays neutral when the pot itself is unusable or the snapshot is missing', () => {
    const p = policy();
    const badPot = facingView(strong, dry, 100, 50, {
      potOdds: { callAmount: 50, pot: Number.NaN, potOdds: Number.NaN, breakEvenEquity: Number.NaN },
    });
    for (let seq = 0; seq < 60; seq++) {
      expect(p.decide({ ...badPot, actionSeq: seq }).action.type).not.toBe('fold');
    }
    const missing = facingView(strong, dry, 100, 50, { potOdds: null });
    expect(() => p.decide(missing)).not.toThrow();
    expect(p.decide(missing).action.type).not.toBe('fold');
  });

  it('does not turn air into a call just because the price is malformed', () => {
    const p = policy();
    const view = facingView(air, dry, 100, 50, {
      potOdds: { callAmount: 50, pot: 100, potOdds: Number.NaN, breakEvenEquity: Number.NaN },
    });
    let folds = 0;
    const n = 120;
    for (let seq = 0; seq < n; seq++) {
      if (p.decide({ ...view, actionSeq: seq }).action.type === 'fold') folds++;
    }
    expect(folds).toBeGreaterThan(n * 0.5);
  });
});
