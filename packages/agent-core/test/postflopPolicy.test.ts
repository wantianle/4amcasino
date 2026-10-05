import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cardFromName,
  evaluate7,
  handCategory,
  legalActions,
  type BettingState,
  type CardId,
} from '@4am/shared';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionPotOdds,
  DecisionSeat,
  DecisionView,
  PublicAction,
} from '../src/decisionView.js';
import type { PolicyDecision } from '../src/policy.js';
import type { PolicyKind } from '../src/policyStyles.js';
import {
  PostflopPolicy,
  bluffBetProbability,
  bluffToValueRatio,
  blockerFactor,
  blockerScore,
  chooseBetFraction,
  classifyTexture,
  defendProbability,
  evaluateHand,
  facingBetMargin,
  facingBetSamples,
  facingVillainRange,
  handPercentile,
  heroInPosition,
  heroWasAggressor,
  mdf,
  rangeAdvantage,
  unknownComboCount,
  valueBetProbability,
} from '../src/postflopPolicy.js';
import { estimateEquity } from '../src/equity.js';
import { deriveRulesSeed } from '../src/rulesSeed.js';
import { RulePolicy } from '../src/rulePolicy.js';
import { RULE_PRESETS } from '../src/ruleStyles.js';
import { ScriptedPolicy } from '../src/scriptedPolicy.js';

const c = (n: string) => cardFromName(n);
const KINDS: PolicyKind[] = [
  'tight-aggressive',
  'loose-aggressive',
  'calling-station',
  'constrained-random',
];

function la(over: Partial<DecisionLegalActions> = {}): DecisionLegalActions {
  return {
    canCheck: false,
    canCall: true,
    callAmount: 50,
    canBet: false,
    canRaise: true,
    minRaiseTo: 100,
    maxRaiseTo: 1000,
    ...over,
  };
}

function hand(myCards: CardId[], board: CardId[], over: Partial<DecisionHand> = {}): DecisionHand {
  return {
    handId: 'h1',
    street: board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : 'flop',
    buttonSeat: 1,
    board,
    pot: 100,
    currentBet: 0,
    toAct: 1,
    deadline: null,
    myCards,
    mySeat: 1,
    ...over,
  };
}

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 1,
    userId: 2,
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

function view(over: Partial<DecisionView> = {}): DecisionView {
  return {
    room: { id: 'r', name: 'r', sb: 1, bb: 2, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: null,
    me: null,
    legalActions: null,
    potOdds: null,
    actionHistory: [],
    opponents: [],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    ...over,
  };
}

/** Facing a half-pot bet on the given board. */
function facingBetView(cards: CardId[], board: CardId[], over: Partial<DecisionView> = {}): DecisionView {
  return view({
    hand: hand(cards, board, { pot: 100, currentBet: 50 }),
    me: seat({ seat: 1, stack: 1000, committed: 50, total: 50 }),
    opponents: [seat({ seat: 0, isMe: false, stack: 1000, committed: 50, total: 50 })],
    legalActions: la({ canCheck: false, canCall: true, callAmount: 50, canRaise: true, canBet: false, minRaiseTo: 100, maxRaiseTo: 1000 }),
    potOdds: { callAmount: 50, pot: 100, potOdds: 50 / 150, breakEvenEquity: 50 / 150 },
    seatOrder: [0, 1],
    actionSeq: 0,
    ...over,
  });
}

/** Facing a bet of `call` into a total pot of `pot` (pot includes the bet). */
function facingViewAt(
  cards: CardId[],
  board: CardId[],
  pot: number,
  call: number,
  over: Partial<DecisionView> = {},
): DecisionView {
  return facingBetView(cards, board, {
    hand: hand(cards, board, { pot, currentBet: call }),
    me: seat({ seat: 1, stack: 1000, committed: call, total: call }),
    opponents: [seat({ seat: 0, isMe: false, stack: 1000, committed: call, total: call })],
    legalActions: la({ canCheck: false, canCall: true, callAmount: call, canRaise: true, canBet: false, minRaiseTo: call * 2, maxRaiseTo: 1000 }),
    potOdds: { callAmount: call, pot, potOdds: call / (pot + call), breakEvenEquity: call / (pot + call) },
    ...over,
  });
}

/** No bet to face: hero can bet or check. */
function unopenedView(cards: CardId[], board: CardId[], over: Partial<DecisionView> = {}): DecisionView {
  return view({
    hand: hand(cards, board, { pot: 100, currentBet: 0 }),
    me: seat({ seat: 1, stack: 1000, committed: 0, total: 0 }),
    opponents: [seat({ seat: 0, isMe: false, stack: 1000, committed: 0, total: 0 })],
    legalActions: la({ canCheck: true, canCall: false, callAmount: 0, canBet: true, canRaise: true, minRaiseTo: 2, maxRaiseTo: 1000 }),
    potOdds: null,
    seatOrder: [0, 1],
    actionSeq: 0,
    ...over,
  });
}

function assertLegal(d: PolicyDecision, legal: DecisionLegalActions): void {
  const a = d.action;
  switch (a.type) {
    case 'check':
      expect(legal.canCheck).toBe(true);
      break;
    case 'call':
      expect(legal.canCall).toBe(true);
      break;
    case 'bet':
      expect(legal.canBet).toBe(true);
      expect(a.amount).toBeGreaterThanOrEqual(legal.minRaiseTo);
      expect(a.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
      break;
    case 'raise':
      expect(legal.canRaise).toBe(true);
      expect(a.amount).toBeGreaterThanOrEqual(legal.minRaiseTo);
      expect(a.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
      break;
    case 'fold':
      break;
  }
}

function stateFor(la: DecisionLegalActions): BettingState {
  const currentBet = la.canCheck ? 0 : la.callAmount;
  const lastRaiseSize = Math.max(1, la.minRaiseTo - currentBet);
  const stack = Math.max(1, la.maxRaiseTo, la.minRaiseTo);
  return {
    street: 'flop',
    buttonSeat: 0,
    sb: 1,
    bb: Math.max(1, la.minRaiseTo),
    currentBet,
    lastRaiseSize,
    lastFullRaiseAt: 0,
    toAct: 0,
    needToAct: [0],
    winnerByFold: null,
    seats: [
      { seat: 0, stack, committed: 0, total: 0, folded: false, allIn: false, lastActedAt: null },
      { seat: 1, stack: 1000, committed: currentBet, total: currentBet, folded: false, allIn: false, lastActedAt: null },
    ],
  };
}

function assertSharedLegal(d: PolicyDecision, legal: DecisionLegalActions): void {
  const st = stateFor(legal);
  expect(legalActions(st)).not.toBeNull();
  applyAction(st, 0, d.action);
}

const TAG = RULE_PRESETS['tight-aggressive'];
const policy = () => new PostflopPolicy({ params: TAG, seed: 7 });

// ---------------------------------------------------------------------------

describe('postflop: shared evaluator (hand ranking)', () => {
  it('delegates to evaluate7 and handles the wheel correctly', () => {
    const cards = [c('As'), c('2c'), c('3d'), c('4h'), c('5c'), c('Ks'), c('Qd')];
    const ev = evaluateHand([c('As'), c('2c')], [c('3d'), c('4h'), c('5c'), c('Ks'), c('Qd')]);
    expect(ev.score).toBe(evaluate7(cards));
    expect(ev.category).toBe(4); // straight, not high card
    expect(handCategory(ev.score)).toBe(4);
  });

  it('ranks a straight flush above quads and a full house', () => {
    const sf = evaluateHand([c('9s'), c('8s')], [c('7s'), c('6s'), c('5s'), c('Kd'), c('Qc')]);
    expect(sf.category).toBe(8);
    const quads = evaluateHand([c('As'), c('Ah')], [c('Ad'), c('Ac'), c('Kd'), c('Ks'), c('2c')]);
    expect(quads.category).toBe(7);
    const boat = evaluateHand([c('Ks'), c('Kh')], [c('Kd'), c('2s'), c('2h'), c('7c'), c('3d')]);
    expect(boat.category).toBe(6);
    expect(sf.score).toBeGreaterThan(quads.score);
    expect(quads.score).toBeGreaterThan(boat.score);
  });

  it('uses correct flush and straight kickers', () => {
    const board = [c('Qs'), c('Js'), c('2s'), c('3d'), c('4c')];
    const ak = evaluateHand([c('As'), c('Ks')], board);
    const a3 = evaluateHand([c('As'), c('3s')], board); // A-Q-J-3-2 flush
    expect(ak.category).toBe(5);
    expect(ak.score).toBeGreaterThan(a3.score);

    const sBoard = [c('Qc'), c('Jd'), c('Ts'), c('2c'), c('3h')];
    const aHigh = evaluateHand([c('As'), c('Kd')], sBoard); // A-K-Q-J-T broadway
    const qHigh = evaluateHand([c('9s'), c('8d')], sBoard); // Q-J-T-9-8
    expect(aHigh.category).toBe(4);
    expect(qHigh.category).toBe(4);
    expect(aHigh.score).toBeGreaterThan(qHigh.score);
  });
});

describe('postflop: MDF', () => {
  it('computes P/(P+B)', () => {
    expect(mdf(50, 50)).toBeCloseTo(0.5, 9);
    expect(mdf(100, 50)).toBeCloseTo(2 / 3, 9);
    expect(mdf(0, 50)).toBe(0);
    expect(mdf(100, 0)).toBe(1);
  });

  it('defendProbability integrates to the required MDF on [0,1], boundaries included', () => {
    for (const required of [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1]) {
      let sum = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) sum += defendProbability((i + 0.5) / n, required);
      expect(Math.abs(sum / n - required)).toBeLessThanOrEqual(0.01);
    }
  });

  // P0 replaced the uniform-MDF short-circuit with a conditional range-equity
  // vs pot-odds decision. Instead of the old frequency claim, this matrix checks
  // the decision against the *same* equity the policy computed (`policyEquity`)
  // for value / medium / air hands across half-pot / pot / overbet / all-in.
  const policySeed = 7;
  const policyEquityOf = (view: DecisionView) => {
    const hole = view.hand!.myCards;
    const board = view.hand!.board;
    const call = view.legalActions!.callAmount;
    const pot = view.potOdds!.pot;
    const potBefore = pot - call;
    const active = Math.max(1, view.opponents.filter((o) => !o.folded).length);
    const samples = facingBetSamples(active);
    const estimate = estimateEquity({
      hole,
      board,
      opponents: active,
      samples,
      seed: deriveRulesSeed(policySeed, view),
      villainRange: facingVillainRange(view, hole, potBefore, call),
    });
    return {
      equity: estimate.equity,
      margin: facingBetMargin(estimate.equity, samples),
      required: view.potOdds!.potOdds,
    };
  };

  const matrixBoard = [c('Kh'), c('7d'), c('2c')];
  const tiers = ['value', 'medium', 'air'] as const;
  type Tier = (typeof tiers)[number];
  const matrixHands: Record<Tier, CardId[]> = {
    value: [c('Kc'), c('Kd')], // trips
    medium: [c('Ks'), c('Qs')], // top pair
    air: [c('8s'), c('3s')], // no pair, no draw
  };
  const matrixSizes: { name: string; pot: number; call: number; allIn: boolean }[] = [
    { name: 'half', pot: 150, call: 50, allIn: false },
    { name: 'pot', pot: 200, call: 100, allIn: false },
    { name: 'overbet', pot: 300, call: 200, allIn: false },
    { name: 'all-in', pot: 300, call: 200, allIn: true },
  ];
  const matrixView = (
    cards: CardId[],
    size: (typeof matrixSizes)[number],
    opponents: number,
    seq: number,
  ): DecisionView => {
    const villains: DecisionSeat[] = [];
    for (let i = 0; i < opponents; i++) {
      villains.push(
        seat({ seat: i + 2, isMe: false, committed: size.call, total: size.call, allIn: size.allIn }),
      );
    }
    return facingViewAt(cards, matrixBoard, size.pot, size.call, {
      actionSeq: seq,
      hand: hand(cards, matrixBoard, { pot: size.pot, currentBet: size.call }),
      opponents: villains,
    });
  };

  it('heads-up matrix: per-cell behaviour, 0% consistency violations, raise layering', () => {
    const p = policy();
    const n = 160; // distinct actionSeq seeds
    const cells = new Map<string, { fold: number; raise: number }>();
    let clearAbove = 0;
    let clearBelow = 0;
    let inconsistent = 0;
    for (const size of matrixSizes) {
      for (const tier of tiers) {
        let folds = 0;
        let raises = 0;
        for (let seq = 0; seq < n; seq++) {
          const v = matrixView(matrixHands[tier], size, 1, seq);
          const action = p.decide(v).action.type;
          if (action === 'fold') folds++;
          if (action === 'raise') raises++;
          const { equity, margin, required } = policyEquityOf(v);
          if (equity > required + margin) {
            clearAbove++;
            if (action === 'fold') inconsistent++;
          } else if (equity < required - margin) {
            clearBelow++;
            if (action !== 'fold') inconsistent++;
          }
        }
        cells.set(`${tier}:${size.name}`, { fold: folds, raise: raises });
      }
    }
    // Every seed's action agrees with the policy's own equity and band.
    expect(inconsistent).toBe(0);
    expect(clearAbove).toBeGreaterThan(0);
    expect(clearBelow).toBeGreaterThan(0);
    // Explicit per-cell expectations for all twelve cells.
    for (const size of matrixSizes) {
      const value = cells.get(`value:${size.name}`)!;
      const medium = cells.get(`medium:${size.name}`)!;
      const air = cells.get(`air:${size.name}`)!;
      expect(value.fold, `value ${size.name} never folds`).toBe(0);
      expect(medium.fold, `medium ${size.name} never folds heads-up`).toBe(0);
      expect(air.fold, `air ${size.name} always folds`).toBe(n);
      // Per-cell minimum aggression proportions.
      expect(value.raise, `value ${size.name} raise rate`).toBeGreaterThan(n * 0.6);
      expect(medium.raise, `medium ${size.name} raise rate`).toBeGreaterThan(n * 0.4);
      expect(air.raise, `air ${size.name} raise rate`).toBe(0);
      // Layering: value out-raises medium in every cell.
      expect(value.raise).toBeGreaterThan(medium.raise);
    }
  });

  it('heads-up: inside the equity band seeds genuinely mix (fold/defend floors)', () => {
    const p = policy();
    const size = matrixSizes[1]!; // pot-sized bet, price 1/3
    const n = 500;
    let inBand = 0;
    let bandFold = 0;
    let bandDefend = 0;
    let inconsistent = 0;
    for (let seq = 0; seq < n; seq++) {
      // ~0.46 percentile: its equity straddles the price, so the band governs.
      const v = matrixView([c('Qc'), c('Tc')], size, 1, seq);
      const action = p.decide(v).action.type;
      const { equity, margin, required } = policyEquityOf(v);
      if (equity > required + margin) {
        if (action === 'fold') inconsistent++;
      } else if (equity < required - margin) {
        if (action !== 'fold') inconsistent++;
      } else {
        inBand++;
        if (action === 'fold') bandFold++;
        else bandDefend++;
      }
    }
    expect(inconsistent).toBe(0);
    expect(inBand).toBeGreaterThan(30); // enough in-band seeds to mean something
    // Neither action may collapse to zero inside the band: both floors must hold.
    expect(bandFold / inBand).toBeGreaterThan(0.3);
    expect(bandDefend / inBand).toBeGreaterThan(0.05);
  });

  it('multiway (3-way, 64 samples): value never folds, air always folds, medium mixes', () => {
    const p = policy();
    const n = 120; // distinct actionSeq seeds
    const opponents = 3;
    expect(facingBetSamples(opponents)).toBe(64);
    const foldsByCell = new Map<string, number>();
    const nonFold: Record<Tier, number> = { value: 0, medium: 0, air: 0 };
    let inconsistent = 0;
    for (const size of matrixSizes) {
      for (const tier of tiers) {
        let folds = 0;
        for (let seq = 0; seq < n; seq++) {
          const v = matrixView(matrixHands[tier], size, opponents, seq);
          const action = p.decide(v).action.type;
          if (action === 'fold') folds++;
          else nonFold[tier]++;
          const { equity, margin, required } = policyEquityOf(v);
          if (equity > required + margin && action === 'fold') inconsistent++;
          if (equity < required - margin && action !== 'fold') inconsistent++;
        }
        foldsByCell.set(`${tier}:${size.name}`, folds);
      }
    }
    expect(inconsistent).toBe(0);
    for (const size of matrixSizes) {
      expect(foldsByCell.get(`value:${size.name}`)).toBe(0); // value never folds
      expect(foldsByCell.get(`air:${size.name}`)).toBe(n); // air always folds
    }
    // Top pair never folds at a half-pot price, and mixes at pot/overbet/all-in.
    expect(foldsByCell.get('medium:half')).toBe(0);
    for (const name of ['pot', 'overbet', 'all-in']) {
      const folds = foldsByCell.get(`medium:${name}`)!;
      expect(folds).toBeGreaterThan(0);
      expect(folds).toBeLessThan(n);
    }
    // Multiway layering survives.
    expect(nonFold.value).toBeGreaterThan(nonFold.medium);
    expect(nonFold.medium).toBeGreaterThan(nonFold.air);
  });

  it('multiway: the band does not collapse a marginal hand to always-fold', () => {
    const p = policy();
    const size = matrixSizes[0]!; // half-pot, MDF threshold 1/3
    const n = 200;
    let inBand = 0;
    let bandDefend = 0;
    for (let seq = 0; seq < n; seq++) {
      // A-T high sits on the boundary against three weighted ranges.
      const v = matrixView([c('Ac'), c('Tc')], size, 3, seq);
      const action = p.decide(v).action.type;
      const { equity, margin, required } = policyEquityOf(v);
      if (Math.abs(equity - required) <= margin) {
        inBand++;
        if (action !== 'fold') bandDefend++;
      }
    }
    expect(inBand).toBeGreaterThan(20);
    // Inside the band the MDF/percentile mix defends, not auto-folds.
    expect(bandDefend / inBand).toBeGreaterThan(0.5);
  });

  it('still continues a strong hand when the pot before the bet is zero (pot odds, not MDF = 0)', () => {
    const board = [c('Kh'), c('7d'), c('2c')];
    const p = policy();
    const value = [c('Kc'), c('Kd')]; // set of kings
    let nonFold = 0;
    const n = 40;
    for (let seq = 0; seq < n; seq++) {
      // potBefore 0 → old MDF was 0 (auto-fold); the price is 50%, so a set
      // must not be folded by construction.
      const v = facingViewAt(value, board, 50, 50, { actionSeq: seq });
      if (p.decide(v).action.type !== 'fold') nonFold++;
    }
    expect(nonFold).toBeGreaterThanOrEqual(n * 0.8);
  });

  it('enumerates opponent combos excluding both the board and hero hole cards', () => {
    const hole = [c('As'), c('Kd')];
    const board = [c('Qh'), c('Jh'), c('2c')];
    expect(unknownComboCount(hole, board)).toBe(1081); // C(47,2), not C(49,2)=1176
    expect(unknownComboCount(hole, [c('Qh'), c('Jh'), c('2c'), c('9d')])).toBe(1035); // C(46,2)
    expect(handPercentile(hole, board)).toBeGreaterThanOrEqual(0);
    expect(handPercentile(hole, board)).toBeLessThanOrEqual(1);
  });
});

describe('postflop: board texture & sizing', () => {
  it('classifies dry / wet / connected boards', () => {
    const dry = classifyTexture([c('Ac'), c('7d'), c('2h')]);
    expect(dry.aceHigh).toBe(true);
    expect(dry.wet).toBe(false);
    expect(dry.connected).toBe(false);

    const wet = classifyTexture([c('Th'), c('9h'), c('8h')]);
    expect(wet.suited).toBe(true);
    expect(wet.connected).toBe(true);
    expect(wet.wet).toBe(true);

    const connected = classifyTexture([c('Ks'), c('Qs'), c('Jd')]);
    expect(connected.connected).toBe(true);
    expect(connected.aceHigh).toBe(false);
    expect(connected.lowConnected).toBe(false);
  });

  it('selects 33/50/75/overbet from texture, SPR and advantage', () => {
    const dry = classifyTexture([c('Ac'), c('7d'), c('2h')]);
    const wet = classifyTexture([c('Th'), c('9h'), c('8h')]);
    expect(chooseBetFraction(dry, { spr: 6, inPosition: true, rangeAdvantage: 0.4 })).toBe(0.33);
    expect(chooseBetFraction(wet, { spr: 6, inPosition: true, rangeAdvantage: 0 })).toBe(0.75);
    expect(chooseBetFraction(wet, { spr: 2, inPosition: false, rangeAdvantage: 0 })).toBe(0.5);
    expect(chooseBetFraction(dry, { spr: 6, inPosition: false, rangeAdvantage: -0.5 })).toBe(0.5);
    expect(
      chooseBetFraction(dry, {
        spr: 6,
        inPosition: true,
        rangeAdvantage: 0.5,
        overbetRoll: 0,
        maxOverbetFrequency: 0.2,
      }),
    ).toBe(1.25);
  });

  it('scores range advantage from aggressor / position / texture', () => {
    const ace = classifyTexture([c('Ac'), c('7d'), c('2h')]);
    const low = classifyTexture([c('9s'), c('8d'), c('7h')]);
    expect(
      rangeAdvantage({ heroWasAggressor: true, inPosition: true, texture: ace }),
    ).toBeGreaterThan(0.7);
    expect(
      rangeAdvantage({ heroWasAggressor: false, inPosition: false, texture: low }),
    ).toBeLessThanOrEqual(-0.3);
  });
});

describe('postflop: value:bluff ratio', () => {
  it('matches the MDF-consistent ratio f/(1+f)', () => {
    for (const f of [0.33, 0.5, 0.75, 1.25]) {
      expect(bluffToValueRatio(f)).toBeCloseTo(f / (1 + f), 9);
    }
  });

  it('targets the ratio per value bet for a neutral blocker (≤25% error)', () => {
    const neutralBlocker = 0.375; // blockerFactor(0.375) === 1
    expect(blockerFactor(neutralBlocker)).toBeCloseTo(1, 9);
    for (const f of [0.33, 0.5, 0.75]) {
      const bluff = bluffBetProbability(TAG, f, 0, neutralBlocker, 1, 1);
      const value = valueBetProbability(TAG, 0);
      const measured = bluff / value;
      const target = bluffToValueRatio(f);
      expect(Math.abs(measured - target) / target).toBeLessThanOrEqual(0.25);
    }
  });

  it('mixes value bets and bluffs in a live decision (seeded)', () => {
    const board = [c('Ks'), c('7s'), c('2d')];
    const p = policy();
    let valueBets = 0;
    let bluffBets = 0;
    for (let i = 0; i < 2000; i++) {
      const v = unopenedView([c('Kc'), c('Kd')], board, { actionSeq: i }); // trips = value
      if (p.decide(v).action.type === 'bet') valueBets++;
      const b = unopenedView([c('8s'), c('3s')], board, { actionSeq: i }); // flush draw = bluff
      if (p.decide(b).action.type === 'bet') bluffBets++;
    }
    expect(valueBets).toBeGreaterThan(1500);
    expect(bluffBets).toBeGreaterThan(0);
    expect(bluffBets).toBeLessThan(valueBets);
  });
});

describe('postflop: blockers', () => {
  it('scores nut/flush blockers above low junk', () => {
    const board = [c('Ks'), c('7s'), c('2d')];
    const high = blockerScore([c('As'), c('Qs')], board);
    const low = blockerScore([c('8s'), c('3s')], board);
    expect(high).toBeGreaterThan(low);
    expect(blockerFactor(high) / blockerFactor(low)).toBeGreaterThanOrEqual(1.5);
  });

  it('blockerFactor is a clamped affine map with explicit boundaries', () => {
    // Documented affine form 0.4 + 1.6·blocker, neutral at blocker = 0.375.
    expect(blockerFactor(0)).toBeCloseTo(0.4, 9);
    expect(blockerFactor(0.375)).toBeCloseTo(1, 9);
    expect(blockerFactor(1)).toBeCloseTo(2.0, 9);
    // Input outside [0,1] (or non-finite) clamps to the [0.2, 2.2] range.
    expect(blockerFactor(-1)).toBeCloseTo(0.4, 9);
    expect(blockerFactor(2)).toBeCloseTo(2.0, 9);
    expect(blockerFactor(Number.NaN)).toBeCloseTo(0.4, 9);
    // Monotone non-decreasing over the domain.
    let prev = -Infinity;
    for (const b of [0, 0.1, 0.25, 0.375, 0.5, 0.75, 0.9, 1]) {
      const f = blockerFactor(b);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('bluffs high-blocker hands at least 1.5× as often as low-blocker ones', () => {
    const board = [c('Ks'), c('7s'), c('2d')];
    const p = policy();
    let high = 0;
    let low = 0;
    for (let i = 0; i < 2000; i++) {
      if (p.decide(unopenedView([c('As'), c('Qs')], board, { actionSeq: i })).action.type === 'bet') high++;
      if (p.decide(unopenedView([c('8s'), c('3s')], board, { actionSeq: i })).action.type === 'bet') low++;
    }
    expect(low).toBeGreaterThan(0);
    expect(high / low).toBeGreaterThanOrEqual(1.5);
  });
});

describe('postflop: bounded opponent modelling', () => {
  const stats = (sample: number, vpip: number, pfr: number) => ({
    seat: 0,
    sampleHands: sample,
    vpipHands: vpip,
    pfrHands: pfr,
    postflopBetsRaises: 0,
    postflopCalls: 0,
  });
  // `vpip`/`pfr` here are hand counts over a 50-hand sample (so the model is
  // active: `sampleHands >= 10`).
  const session = (vpipCount: number, pfrCount: number) => ({
    handsObserved: 50,
    netChips: null,
    recentHands: [],
    opponents: [stats(50, vpipCount, pfrCount)],
  });

  it('ignores opponents with fewer than 10 observed hands', () => {
    const board = [c('Ks'), c('7s'), c('2d')];
    const p = policy();
    let lowSample = 0;
    let neutral = 0;
    for (let i = 0; i < 2000; i++) {
      const withTinySample = unopenedView([c('8s'), c('3s')], board, {
        actionSeq: i,
        sessionMemory: { handsObserved: 5, netChips: null, recentHands: [], opponents: [stats(5, 0, 0)] },
      });
      if (p.decide(withTinySample).action.type === 'bet') lowSample++;
      const withNoStats = unopenedView([c('8s'), c('3s')], board, { actionSeq: i });
      if (p.decide(withNoStats).action.type === 'bet') neutral++;
    }
    expect(lowSample).toBe(neutral);
  });

  it('bluffs less into a station and more into a nit (bounded)', () => {
    const board = [c('Ks'), c('7s'), c('2d')];
    const p = policy();
    let stationBets = 0;
    let nitBets = 0;
    for (let i = 0; i < 2000; i++) {
      const station = unopenedView([c('8s'), c('3s')], board, {
        actionSeq: i,
        sessionMemory: session(30, 5), // VPIP .60 / PFR .10
      });
      if (p.decide(station).action.type === 'bet') stationBets++;
      const nit = unopenedView([c('8s'), c('3s')], board, {
        actionSeq: i,
        sessionMemory: session(5, 3), // VPIP .10
      });
      if (p.decide(nit).action.type === 'bet') nitBets++;
    }
    expect(stationBets).toBeGreaterThan(0);
    expect(stationBets).toBeLessThan(nitBets);
  });
});

describe('postflop: positional / aggression helpers', () => {
  it('detects in-position and preflop aggressor from public info', () => {
    const ip = facingBetView([c('Ac'), c('Kd')], [c('Qh'), c('Jh'), c('2c')], {
      me: seat({ seat: 1, isMe: true }),
    });
    expect(heroInPosition(ip)).toBe(true);
    const oop = facingBetView([c('Ac'), c('Kd')], [c('Qh'), c('Jh'), c('2c')], {
      me: seat({ seat: 0, isMe: true }),
      opponents: [seat({ seat: 1, isMe: false })],
      hand: hand([c('Ac'), c('Kd')], [c('Qh'), c('Jh'), c('2c')], { mySeat: 0, toAct: 0 }),
    });
    expect(heroInPosition(oop)).toBe(false);

    const agg: PublicAction = { actionSeq: 0, street: 'preflop', seat: 1, action: { type: 'raise', amount: 6 }, auto: false, ts: 0 };
    expect(heroWasAggressor(facingBetView([c('Ac'), c('Kd')], [c('Qh'), c('Jh'), c('2c')], { actionHistory: [agg] }))).toBe(true);
  });
});

describe('postflop: reproducibility', () => {
  const v = () => unopenedView([c('8s'), c('3s')], [c('Ks'), c('7s'), c('2d')], { actionSeq: 3 });

  it('same view + seed decides identically 1000 times', () => {
    const p = policy();
    const first = p.decide(v());
    for (let i = 0; i < 1000; i++) expect(p.decide(v())).toEqual(first);
  });

  it('different seeds produce a mixed set of actions', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 1000; s++) {
      seen.add(new PostflopPolicy({ params: TAG, seed: s }).decide(v()).action.type);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('postflop: legality', () => {
  it('never returns an illegal action across streets, boards, styles and legal shapes', () => {
    const boards: CardId[][] = [
      [c('Ac'), c('7d'), c('2h')],
      [c('Th'), c('9h'), c('8h')],
      [c('Ks'), c('Qs'), c('Jd'), c('2c')],
      [c('2d'), c('2h'), c('7c'), c('9s'), c('Ah')],
    ];
    const legals = [
      la(),
      la({ canCheck: true, canCall: false, callAmount: 0, canBet: true, canRaise: true, minRaiseTo: 2, maxRaiseTo: 1000 }),
      la({ canCheck: false, canCall: true, canRaise: false, callAmount: 10, minRaiseTo: 0, maxRaiseTo: 0 }),
      la({ canCheck: false, canCall: true, canRaise: true, callAmount: 20, minRaiseTo: 40, maxRaiseTo: 40 }),
    ];
    const holes = [[c('Ac'), c('Kd')], [c('7c'), c('2d')], [c('Ah'), c('Kh')]];
    for (const kind of KINDS) {
      const p = new PostflopPolicy({ params: RULE_PRESETS[kind], seed: 5 });
      for (const board of boards) {
        for (const cards of holes) {
          for (const legal of legals) {
            const v = facingBetView(cards, board, {
              legalActions: legal,
              potOdds: { callAmount: legal.callAmount, pot: 100, potOdds: 0.3, breakEvenEquity: 0.3 },
            });
            const d = p.decide(v);
            assertLegal(d, legal);
            assertSharedLegal(d, legal);
          }
        }
      }
    }
  });

  it('fails closed to a shared-legal action on malformed legal shapes', () => {
    const malformed = [
      la({ canCheck: false, canCall: true, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 }),
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 0, maxRaiseTo: 0 }),
      la({ canCheck: false, canCall: true, canRaise: true, callAmount: 10, minRaiseTo: 100, maxRaiseTo: 40 }),
      la({ canCheck: false, canCall: false, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 }),
    ];
    const board = [c('Ac'), c('7d'), c('2h')];
    for (const kind of KINDS) {
      const p = new PostflopPolicy({ params: RULE_PRESETS[kind], seed: 5 });
      for (const legal of malformed) {
        const v = facingBetView([c('Ac'), c('Kd')], board, { legalActions: legal });
        const d = p.decide(v);
        assertLegal(d, { ...legal, canCheck: true, canCall: legal.callAmount > 0, canRaise: false });
        assertSharedLegal(d, legal);
      }
    }
  });
});

describe('postflop: short-stack all-in', () => {
  it('bets the whole stack (all-in) at <20BB unopened', () => {
    const board = [c('Ac'), c('7d'), c('2h')];
    const p = policy();
    let found = false;
    for (let seq = 0; seq < 50 && !found; seq++) {
      const v = view({
        room: { id: 'r', name: 'r', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
        hand: hand([c('As'), c('Ad')], board, { pot: 100, currentBet: 0 }),
        me: seat({ seat: 1, stack: 1900, committed: 0, total: 0 }),
        opponents: [seat({ seat: 0, isMe: false, stack: 1900, committed: 0, total: 0 })],
        legalActions: la({ canCheck: true, canCall: false, callAmount: 0, canBet: true, canRaise: true, minRaiseTo: 2, maxRaiseTo: 1900 }),
        seatOrder: [0, 1],
        actionSeq: seq,
      });
      const d = p.decide(v);
      if (d.action.type === 'bet') {
        expect(d.action.amount).toBe(1900);
        expect(d.reason).toMatch(/all-in/);
        assertLegal(d, v.legalActions!);
        found = true;
      }
    }
    expect(found).toBe(true);
  });
});

describe('postflop: RulePolicy integration & fail-closed', () => {
  const board = [c('Ac'), c('7d'), c('2h')];
  const boom = {
    name: 'boom',
    decide: (): PolicyDecision => {
      throw new Error('boom');
    },
  };

  it('uses the rules-v1 postflop engine', () => {
    const v = unopenedView([c('As'), c('Ad')], board);
    const d = new RulePolicy({ kind: 'tight-aggressive', seed: 1 }).decide(v);
    expect(d.reason).toMatch(/rules-v1 postflop/);
    assertLegal(d, v.legalActions!);
  });

  it('calls the fallback when the postflop engine throws (sentinel proof)', () => {
    const sentinel = {
      name: 'sentinel',
      decide: (): PolicyDecision => ({ action: { type: 'check' }, reason: 'SENTINEL' }),
    };
    const p = new RulePolicy({ kind: 'tight-aggressive', seed: 1, postflop: boom, fallback: sentinel });
    const v = unopenedView([c('As'), c('Ad')], board);
    expect(p.decide(v).reason).toBe('SENTINEL');
  });

  it('rejects an illegal fallback action and returns a fail-closed action', () => {
    const illegal = {
      name: 'illegal',
      decide: (): PolicyDecision => ({ action: { type: 'bet', amount: 1 }, reason: 'ILLEGAL' }),
    };
    const p = new RulePolicy({ kind: 'tight-aggressive', seed: 1, postflop: boom, fallback: illegal });
    const v = unopenedView([c('As'), c('Ad')], board);
    const d = p.decide(v);
    expect(d.reason).toMatch(/fail-closed/);
    assertLegal(d, v.legalActions!);
  });

  it('survives a throwing fallback', () => {
    const bad = {
      name: 'bad',
      decide: (): PolicyDecision => {
        throw new Error('fallback boom');
      },
    };
    const p = new RulePolicy({ kind: 'tight-aggressive', seed: 1, postflop: boom, fallback: bad });
    const v = unopenedView([c('As'), c('Ad')], board);
    const d = p.decide(v);
    expect(d.reason).toMatch(/fail-closed/);
    assertLegal(d, v.legalActions!);
    assertSharedLegal(d, v.legalActions!);
  });

  it('does not need the legacy fallback for normal play', () => {
    const p = new RulePolicy({ kind: 'tight-aggressive', seed: 1, fallback: new ScriptedPolicy() });
    const v = facingBetView([c('Ac'), c('Kd')], board);
    const d = p.decide(v);
    expect(d.reason).toMatch(/rules-v1 postflop/);
    assertLegal(d, v.legalActions!);
  });
});

// Performance benchmarks assert on wall-clock time, so they fail spuriously under CI load or
// when several lanes run vitest concurrently (measured p95 drifts 5.13ms <-> 24.89ms on the same
// code). They are gated off by default and run explicitly via `npm run test:bench`.
describe.runIf(process.env.RUN_BENCH === '1')('postflop: performance', () => {
  const board = [c('Ac'), c('7d'), c('2h')];
  const hole = [c('Ks'), c('Qd')];

  /** `opponents` active villains facing hero with a half-pot bet. */
  const multiView = (opponents: number, seq: number): DecisionView => {
    const base = facingViewAt(hole, board, 150, 50, { actionSeq: seq });
    const villains: DecisionSeat[] = [];
    for (let i = 0; i < opponents; i++) {
      villains.push(
        seat({ seat: i + 2, isMe: false, committed: 50, total: 50 }),
      );
    }
    return { ...base, opponents: villains };
  };

  const measureP95 = (opponents: number): number => {
    const p = policy();
    // Warm the board / villain-tier caches (the one-time cost).
    p.decide(multiView(opponents, 0));
    const times: number[] = [];
    for (let i = 0; i < 120; i++) {
      const v = multiView(opponents, i + 1);
      const t0 = performance.now();
      p.decide(v);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length * 0.95)]!;
  };

  it('heads-up p95 is inside the per-decision budget', () => {
    // The performance budget is defined for heads-up: it runs the full
    // `P0_EQUITY_SAMPLES` and is the common live case.
    const p95 = measureP95(1);
    console.log(`postflop decision p95: heads-up ${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThanOrEqual(20);
  });

  it('reports 2/4/8-way p95 truthfully (multiway is the coarse approximation)', () => {
    const results = [2, 4, 8].map((opponents) => ({ opponents, p95: measureP95(opponents) }));
    for (const r of results) {
      console.log(`postflop decision p95: ${r.opponents}-way ${r.p95.toFixed(2)}ms`);
    }
    // Multiway uses the halved sample budget (`facingBetSamples`) with an
    // error-matched band, so only a generous smoke ceiling is asserted; the
    // measured numbers above are the honest report, not a tight budget.
    for (const r of results) expect(r.p95).toBeLessThanOrEqual(120);
  });
});
