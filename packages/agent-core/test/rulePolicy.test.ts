import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cardFromName,
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
import { mulberry32 } from '../src/equity.js';
import type { PolicyDecision } from '../src/policy.js';
import type { PolicyKind } from '../src/policyStyles.js';
import { choosePreflopIntent, derivePreflopContext } from '../src/preflopPolicy.js';
import { RFI_RANGES } from '../src/preflopRanges.js';
import {
  allHandClasses,
  compileRangeMix,
  parseRange,
  type CompiledMix,
} from '../src/rangeParser.js';
import { RulePolicy } from '../src/rulePolicy.js';
import { heroIsIPToOpener, heroInPosition, lastPreflopRaiserSeat } from '../src/postflopPolicy.js';
import { RULE_PRESETS, parseRuleConfig, type RuleParams } from '../src/ruleStyles.js';
import { resolvePolicy } from '../src/stylePolicy.js';

const c = (n: string) => cardFromName(n);

const KINDS: PolicyKind[] = [
  'tight-aggressive',
  'loose-aggressive',
  'calling-station',
  'constrained-random',
];

/**
 * Explicit legacy engine. The headcount-adaptive charts are the shipped default
 * now, so tests that characterise the legacy position tables / marginal-open
 * style knobs opt into the legacy route on purpose instead of inheriting an
 * untouched preset (which is adaptive). Adaptive coverage lives in
 * `preflopAdaptive.test.ts`.
 */
const legacyParams = (kind: PolicyKind): RuleParams => ({
  ...RULE_PRESETS[kind],
  adaptivePreflop: false,
});

// ---------------------------------------------------------------------------
// small view builders
// ---------------------------------------------------------------------------

function la(over: Partial<DecisionLegalActions> = {}): DecisionLegalActions {
  return {
    canCheck: false,
    canCall: true,
    callAmount: 10,
    canBet: false,
    canRaise: false,
    minRaiseTo: 20,
    maxRaiseTo: 100,
    ...over,
  };
}

function hand(myCards: CardId[], over: Partial<DecisionHand> = {}): DecisionHand {
  return {
    handId: 'h1',
    street: 'preflop',
    buttonSeat: 0,
    board: [],
    pot: 0,
    currentBet: 0,
    toAct: 0,
    deadline: null,
    myCards,
    mySeat: 0,
    ...over,
  };
}

function odds(over: Partial<DecisionPotOdds> = {}): DecisionPotOdds {
  return { callAmount: 10, pot: 100, potOdds: 10 / 110, breakEvenEquity: 10 / 110, ...over };
}

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 1,
    userId: 2,
    displayName: 'opp',
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

function view(over: Partial<DecisionView> = {}): DecisionView {
  return {
    room: null,
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
      {
        seat: 1,
        stack: 1000,
        committed: currentBet,
        total: currentBet,
        folded: false,
        allIn: false,
        lastActedAt: null,
      },
    ],
  };
}

function assertSharedLegal(d: PolicyDecision, legal: DecisionLegalActions): void {
  const st = stateFor(legal);
  expect(legalActions(st)).not.toBeNull();
  applyAction(st, 0, d.action);
}

// ---------------------------------------------------------------------------
// 9-max preflop fixtures
// ---------------------------------------------------------------------------

type Pos = 'UTG' | 'UTG1' | 'MP' | 'LJ' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';
const POS_INDEX: Record<Pos, number> = {
  SB: 0,
  BB: 1,
  UTG: 2,
  UTG1: 3,
  MP: 4,
  LJ: 5,
  HJ: 6,
  CO: 7,
  BTN: 8,
};
const SEAT_ORDER = Array.from({ length: 9 }, (_, i) => i);
const BUTTON = 8;
const BB = 100;
const STACK = 10_000;

function publicRaise(seatNo: number, amount: number, seq: number): PublicAction {
  return {
    actionSeq: seq,
    street: 'preflop',
    seat: seatNo,
    action: { type: 'raise', amount },
    auto: false,
    ts: 0,
  };
}

function publicCall(seatNo: number, seq: number): PublicAction {
  return { actionSeq: seq, street: 'preflop', seat: seatNo, action: { type: 'call' }, auto: false, ts: 0 };
}

function preflopView(
  pos: Pos,
  cards: CardId[],
  over: Partial<DecisionView> = {},
  stack = STACK,
): DecisionView {
  const mySeat = POS_INDEX[pos];
  const committed = pos === 'SB' ? 50 : pos === 'BB' ? 100 : 0;
  const callAmount = pos === 'SB' ? 50 : 100;
  const me = seat({
    seat: mySeat,
    userId: 1,
    displayName: 'hero',
    isMe: true,
    stack,
    committed,
    total: committed,
  });
  const opponents = SEAT_ORDER.filter((s) => s !== mySeat).map((s) =>
    seat({ seat: s, userId: 100 + s, displayName: `v${s}`, stack, committed: 0, total: 0 }),
  );
  const legal = la({
    canCheck: false,
    canCall: true,
    callAmount,
    canBet: false,
    canRaise: true,
    minRaiseTo: 200,
    maxRaiseTo: stack,
  });
  return view({
    room: { id: 'r1', name: 'room', sb: 50, bb: BB, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: hand(cards, {
      street: 'preflop',
      buttonSeat: BUTTON,
      board: [],
      pot: 150,
      currentBet: BB,
      toAct: mySeat,
      mySeat,
    }),
    me,
    legalActions: legal,
    potOdds: odds({
      callAmount,
      pot: 150,
      potOdds: callAmount / (150 + callAmount),
      breakEvenEquity: callAmount / (150 + callAmount),
    }),
    opponents,
    seatOrder: SEAT_ORDER,
    actionSeq: 0,
    ...over,
  });
}

function allCombos(): CardId[][] {
  const out: CardId[][] = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) out.push([a, b]);
  return out;
}

// ---------------------------------------------------------------------------
// range parser
// ---------------------------------------------------------------------------

describe('range parser', () => {
  it('expands pairs, plus, dash, single classes and whitespace-separated tokens', () => {
    expect([...parseRange('77+').keys].sort()).toEqual(
      ['77', '88', '99', 'AA', 'JJ', 'KK', 'QQ', 'TT'].sort(),
    );
    expect(parseRange('77+').combos).toBe(8 * 6);
    expect([...parseRange('AJs+').keys].sort()).toEqual(['AJs', 'AKs', 'AQs']);
    expect(parseRange('AJs+').combos).toBe(3 * 4);
    expect([...parseRange('ATo+').keys].sort()).toEqual(['AJo', 'AKo', 'AQo', 'ATo']);
    expect(parseRange('ATo+').combos).toBe(4 * 12);
    expect([...parseRange('A5s-A2s').keys].sort()).toEqual(['A2s', 'A3s', 'A4s', 'A5s']);
    expect(parseRange('A5s-A2s').combos).toBe(4 * 4);
    expect([...parseRange('KTs').keys]).toEqual(['KTs']);
    expect(parseRange('KTs').combos).toBe(4);
    // Whitespace is a separator too, and spaces around `-`/`+` are tolerated.
    expect([...parseRange('AA KK').keys].sort()).toEqual(['AA', 'KK']);
    expect([...parseRange('A5s - A2s').keys].sort()).toEqual(['A2s', 'A3s', 'A4s', 'A5s']);
    expect([...parseRange('AJs +').keys].sort()).toEqual(['AJs', 'AKs', 'AQs']);
    // `+` is same-high kicker expansion: T9s+ is only T9s (no diagonal).
    expect([...parseRange('T9s+').keys]).toEqual(['T9s']);
  });

  it('covers exactly 169 classes / 1326 combos', () => {
    const classes = allHandClasses();
    expect(classes).toHaveLength(169);
    expect(classes.reduce((s, h) => s + h.combos, 0)).toBe(1326);
  });

  it('keeps value, bluff, marginal and call roles separate', () => {
    const mix = compileRangeMix([
      { range: 'QQ+, AKs', action: 'raise', weight: 1 },
      { range: 'A5s', action: 'raise', weight: 0.5 },
      { range: 'A5s', action: 'call', weight: 1 },
      { range: 'KQs', action: 'raise', weight: 1, role: 'marginal' },
    ]);
    const aa = mix.get('AA') as CompiledMix;
    expect(aa).toEqual({ valueRaise: 1, bluffRaise: 0, marginalRaise: 0, call: 0 });
    const a5 = mix.get('A5s') as CompiledMix;
    expect(a5).toEqual({ valueRaise: 0, bluffRaise: 0.5, marginalRaise: 0, call: 1 });
    expect((mix.get('KQs') as CompiledMix).marginalRaise).toBe(1);
    expect(mix.get('72o')).toBeUndefined();
  });

  it('accepts the full baseline RFI string and reports invalid tokens', () => {
    const parsed = parseRange(
      '44+, A7s+, A5s-A2s, K9s+, Q9s+, J9s+, T8s+, 98s, 87s, ATo+, KJo+, QJo',
    );
    expect(parsed.invalid).toEqual([]);
    expect(parsed.keys.size).toBeGreaterThan(40);
    expect(parseRange('nonsense, 77+').invalid).toEqual(['nonsense']);
  });
});

// ---------------------------------------------------------------------------
// preflop RFI frequencies
// ---------------------------------------------------------------------------

describe('preflop RFI frequency', () => {
  // Exact table combo counts (combos / 1326); the tables hit these literally.
  const EXACT_COMBOS: Record<Pos, number> = {
    UTG: 136,
    UTG1: 144,
    MP: 196,
    LJ: 216,
    HJ: 246,
    CO: 304,
    BTN: 562,
    SB: 526,
    BB: 0,
  };
  const NOMINAL: Partial<Record<Pos, [number, number]>> = {
    UTG: [9, 13],
    MP: [13, 18],
    HJ: [18, 24],
    CO: [24, 30],
    BTN: [40, 50],
    SB: [38, 48],
  };
  const TOL = 2.5;

  it('enumerates all 1326 combos and matches the exact table counts', () => {
    const combos = allCombos();
    expect(combos).toHaveLength(1326);
    for (const pos of Object.keys(EXACT_COMBOS) as Pos[]) {
      const expected = EXACT_COMBOS[pos];
      // Sanity: the expected count is what the table parses to.
      expect(parseRange(RFI_RANGES[pos]).combos).toBe(expected);
      // This pins the *legacy* RFI table count, so force the legacy engine.
      const policy = new RulePolicy({
        kind: 'tight-aggressive',
        seed: 1,
        params: legacyParams('tight-aggressive'),
      });
      let raises = 0;
      for (const cards of combos) {
        const d = policy.decide(preflopView(pos, cards));
        if (d.action.type === 'raise' || d.action.type === 'bet') raises++;
      }
      expect(raises).toBe(expected);
    }
  });

  it('stays within the nominal band on every position (exact enumeration)', () => {
    const combos = allCombos();
    for (const [pos, [lo, hi]] of Object.entries(NOMINAL) as [Pos, [number, number]][]) {
      const policy = new RulePolicy({
        kind: 'tight-aggressive',
        seed: 1,
        params: legacyParams('tight-aggressive'),
      });
      let raises = 0;
      for (const cards of combos) {
        const d = policy.decide(preflopView(pos, cards));
        if (d.action.type === 'raise' || d.action.type === 'bet') raises++;
      }
      const pct = (raises / combos.length) * 100;
      expect(pct).toBeGreaterThanOrEqual(lo - TOL);
      expect(pct).toBeLessThanOrEqual(hi + TOL);
    }
  });
});

// ---------------------------------------------------------------------------
// value protection, incomplete history, short stacks (P1)
// ---------------------------------------------------------------------------

describe('RulePolicy: value protection', () => {
  const tag = RULE_PRESETS['tight-aggressive'];

  it('never folds AA multiway: value continuation is not discounted', () => {
    const v = preflopView('MP', [c('Ac'), c('Ad')], {
      actionHistory: [publicRaise(2, 300, 0), publicCall(3, 1)],
      actionSeq: 2,
    });
    // Roll just under 1: a discounted value raise would fold here.
    const choice = choosePreflopIntent(v, tag, () => 0.999);
    expect(choice.frequencies).toEqual({ raise: 1, call: 0 });
    expect(choice.intent).toBe('raise');
  });

  it('never folds AA when history is incomplete', () => {
    const v = preflopView('MP', [c('Ac'), c('Ad')], {
      actionHistory: [publicRaise(2, 300, 0)],
      historyComplete: false,
      actionSeq: 2,
    });
    const choice = choosePreflopIntent(v, tag, () => 0.999);
    expect(choice.frequencies).toEqual({ raise: 1, call: 0 });
    expect(choice.intent).toBe('raise');
  });

  it('turns a discounted value raise into a call, never a fold', () => {
    // Calling-station threeBetScale 0.35: AA still continues, as a flat call.
    const v = preflopView('BTN', [c('Ac'), c('Ad')], {
      actionHistory: [publicRaise(2, 300, 0)],
      actionSeq: 2,
    });
    const choice = choosePreflopIntent(v, RULE_PRESETS['calling-station'], () => 0.9);
    expect(choice.frequencies.raise + choice.frequencies.call).toBeCloseTo(1, 9);
    expect(choice.frequencies.raise).toBeCloseTo(0.35, 9);
    expect(choice.intent).toBe('call');
  });
});

describe('RulePolicy: incomplete history is not silence', () => {
  const tag = RULE_PRESETS['tight-aggressive'];

  it('treats a public 3BB open as facing a raise even with no observed action', () => {
    const v = preflopView('MP', [c('5c'), c('5d')], {
      actionHistory: [],
      historyComplete: false,
      actionSeq: 0,
      hand: hand([c('5c'), c('5d')], {
        street: 'preflop',
        buttonSeat: BUTTON,
        pot: 450,
        currentBet: 300,
        toAct: POS_INDEX.MP,
        mySeat: POS_INDEX.MP,
      }),
    });
    const ctx = derivePreflopContext(v);
    expect(ctx.incompleteOpen).toBe(true);
    expect(ctx.spot).toBe('facingOpen');
    // 55 flats an EP open; rand 0 would raise if it were still "unopened".
    const choice = choosePreflopIntent(v, tag, () => 0);
    expect(choice.intent).toBe('call');
    expect(choice.frequencies.raise).toBe(0);
  });

  it('routes a partial auction with a raise to the tight cold range', () => {
    const partial = preflopView('CO', [c('5c'), c('5d')], {
      actionHistory: [publicRaise(2, 300, 0)],
      historyComplete: false,
      actionSeq: 1,
    });
    expect(derivePreflopContext(partial).spot).toBe('facing3BetCold');
    // 55 would flat a single open, but a hidden higher raise must be assumed.
    expect(choosePreflopIntent(partial, tag, () => 0).intent).toBe('fold');
    const complete = preflopView('CO', [c('5c'), c('5d')], {
      actionHistory: [publicRaise(2, 300, 0)],
      actionSeq: 1,
    });
    expect(choosePreflopIntent(complete, tag, () => 0).intent).toBe('call');

    // Hero already raised: a hidden re-raise is assumed -> 4-bet+ range (AA continues).
    const heroOpened = preflopView('BTN', [c('Ac'), c('Ad')], {
      actionHistory: [publicRaise(8, 200, 0)],
      historyComplete: false,
      actionSeq: 1,
    });
    expect(derivePreflopContext(heroOpened).spot).toBe('facing4BetPlus');
    expect(choosePreflopIntent(heroOpened, tag, () => 0.999).intent).toBe('raise');
  });
});

describe('RulePolicy: short stacks', () => {
  // Short-stack behaviour is the legacy rules-v1 stack mapping; pin the engine.
  const tag = legacyParams('tight-aggressive');

  it('jams QQ facing a 3-bet at 19BB instead of folding', () => {
    const v = preflopView(
      'BTN',
      [c('Qc'), c('Qd')],
      {
        actionHistory: [publicRaise(8, 200, 0), publicRaise(2, 700, 1)],
        actionSeq: 2,
      },
      1900,
    );
    const ctx = derivePreflopContext(v);
    expect(ctx.stackBB).toBeCloseTo(19, 9);
    expect(ctx.spot).toBe('facing3Bet');
    const choice = choosePreflopIntent(v, tag, () => 0.99);
    expect(choice.frequencies).toEqual({ raise: 1, call: 0 });
    expect(choice.intent).toBe('raise');
  });

  it('sizes a short-stack raise as an explicit all-in shove', () => {
    const v = preflopView(
      'BTN',
      [c('Qc'), c('Qd')],
      {
        actionHistory: [publicRaise(8, 200, 0), publicRaise(2, 700, 1)],
        actionSeq: 2,
        legalActions: la({
          canCheck: false,
          canCall: true,
          callAmount: 700,
          canBet: false,
          canRaise: true,
          minRaiseTo: 1400,
          maxRaiseTo: 1900,
        }),
      },
      1900,
    );
    const d = new RulePolicy({
        kind: 'tight-aggressive',
        seed: 1,
        params: legacyParams('tight-aggressive'),
      }).decide(v);
    expect(d.action).toEqual({ type: 'raise', amount: 1900 });
    expect(d.reason).toMatch(/all-in/);
  });

  it('does not open-jam speculative hands at 19BB unopened', () => {
    for (const cards of [
      [c('9c'), c('8c')], // 98s: opens at 100BB, must NOT open-shove
      [c('Ac'), c('2c')], // A2s
      [c('2c'), c('2d')], // 22
    ]) {
      const v = preflopView('BTN', cards, {}, 1900);
      const choice = choosePreflopIntent(v, tag, () => 0.99);
      expect(choice.intent).toBe('fold');
      expect(choice.frequencies.raise).toBe(0);
      const d = new RulePolicy({
        kind: 'tight-aggressive',
        seed: 1,
        params: legacyParams('tight-aggressive'),
      }).decide(v);
      expect(d.action.type).toBe('fold');
    }
  });

  it('open-jams premiums at 19BB unopened', () => {
    for (const cards of [
      [c('Ac'), c('Ad')], // AA
      [c('Kc'), c('Kd')], // KK
      [c('Qc'), c('Qd')], // QQ
      [c('Ac'), c('Kc')], // AKs
    ]) {
      const legal = la({
        canCheck: false,
        canCall: true,
        callAmount: 100,
        canBet: false,
        canRaise: true,
        minRaiseTo: 200,
        maxRaiseTo: 1900,
      });
      const v = preflopView('BTN', cards, { legalActions: legal }, 1900);
      expect(choosePreflopIntent(v, tag, () => 0.99).intent).toBe('raise');
      const d = new RulePolicy({
        kind: 'tight-aggressive',
        seed: 1,
        params: legacyParams('tight-aggressive'),
      }).decide(v);
      expect(d.action).toEqual({ type: 'raise', amount: 1900 });
      expect(d.reason).toMatch(/all-in/);
    }
  });

  it('keeps deep-stack opens as normal raises, never a jam', () => {
    for (const cards of [
      [c('9c'), c('8c')],
      [c('Ac'), c('2c')],
      [c('2c'), c('2d')],
    ]) {
      const v = preflopView('BTN', cards, {}, 10_000);
      const d = new RulePolicy({
        kind: 'tight-aggressive',
        seed: 1,
        params: legacyParams('tight-aggressive'),
      }).decide(v);
      expect(d.action.type).toBe('raise');
      expect(d.action.amount).toBeLessThan(10_000);
    }
  });

  it('does not jam a speculative hand facing an open at 19BB', () => {
    const v = preflopView(
      'MP',
      [c('9c'), c('8c')],
      { actionHistory: [publicRaise(2, 300, 0)], actionSeq: 2 },
      1900,
    );
    expect(choosePreflopIntent(v, tag, () => 0).intent).toBe('fold');
  });
});

describe('RulePolicy: effective stack definition', () => {
  it('uses min(hero, largest active opponent) and ignores folded / all-in seats', () => {
    const base = preflopView('BTN', [c('Ac'), c('Ad')], {}, 5000);
    // One active opponent with 2000 caps us: min(5000, 2000) = 20BB.
    const equal = { ...base, opponents: base.opponents.map((o) => ({ ...o, stack: 2000 })) };
    expect(derivePreflopContext(equal).stackBB).toBeCloseTo(20, 9);
    // A tiny all-in opponent must not cap us; the 8000 active one does.
    const allIn = {
      ...base,
      opponents: base.opponents.map((o, i) =>
        i === 0 ? { ...o, stack: 100, allIn: true } : { ...o, stack: 8000 },
      ),
    };
    expect(derivePreflopContext(allIn).stackBB).toBeCloseTo(50, 9);
    // Everyone else folded: fall back to hero's own stack.
    const folded = { ...base, opponents: base.opponents.map((o) => ({ ...o, folded: true })) };
    expect(derivePreflopContext(folded).stackBB).toBeCloseTo(50, 9);
    expect(derivePreflopContext(folded).myStackBB).toBeCloseTo(50, 9);
  });
});

// ---------------------------------------------------------------------------
// positions & spots (P2)
// ---------------------------------------------------------------------------

describe('preflop positions', () => {
  it('maps a heads-up button to SB without seatOrder and raises AA', () => {
    const cards = [c('Ac'), c('Ad')];
    const huButton = view({
      room: { id: 'r1', name: 'hu', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
      hand: hand(cards, { street: 'preflop', buttonSeat: 0, currentBet: 100, toAct: 0, mySeat: 0, pot: 150 }),
      me: seat({ seat: 0, userId: 1, isMe: true, stack: 10_000, committed: 50, total: 50 }),
      opponents: [seat({ seat: 1, userId: 2, stack: 10_000, committed: 100, total: 100 })],
      legalActions: la({ canCheck: false, canCall: true, callAmount: 50, canRaise: true, minRaiseTo: 200, maxRaiseTo: 10_000 }),
      // deliberately no seatOrder
    });
    const ctx = derivePreflopContext(huButton);
    expect(ctx.position).toBe('SB');
    const choice = choosePreflopIntent(huButton, RULE_PRESETS['tight-aggressive'], () => 0.9);
    expect(choice.intent).toBe('raise');
  });

  it('documents the short-handed anchor mapping (6-max -> UTG/HJ/CO/BTN)', () => {
    const six = [0, 1, 2, 3, 4, 5];
    const at = (mySeat: number) =>
      derivePreflopContext(
        view({
          hand: hand([c('Ac'), c('Ad')], { buttonSeat: 5, mySeat }),
          seatOrder: six,
        }),
      ).position;
    expect(at(2)).toBe('UTG');
    expect(at(3)).toBe('HJ');
    expect(at(4)).toBe('CO');
    expect(at(5)).toBe('BTN');
    expect(at(0)).toBe('SB');
    expect(at(1)).toBe('BB');
  });

  it('maps the heads-up non-button to BB and defends AA versus a SB open', () => {
    const cards = [c('Ac'), c('Ad')];
    const huBb = view({
      room: { id: 'r1', name: 'hu', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
      hand: hand(cards, { street: 'preflop', buttonSeat: 0, currentBet: 300, toAct: 1, mySeat: 1, pot: 450 }),
      me: seat({ seat: 1, userId: 2, isMe: true, stack: 10_000, committed: 100, total: 100 }),
      opponents: [seat({ seat: 0, userId: 1, stack: 10_000, committed: 300, total: 300 })],
      legalActions: la({ canCheck: false, canCall: true, callAmount: 200, canRaise: true, minRaiseTo: 500, maxRaiseTo: 10_000 }),
      actionHistory: [publicRaise(0, 300, 0)],
    });
    expect(derivePreflopContext(huBb).position).toBe('BB');
    const choice = choosePreflopIntent(huBb, RULE_PRESETS['tight-aggressive'], () => 0.99);
    expect(choice.intent).toBe('raise');
  });
});

describe('preflop spots', () => {
  const tag = RULE_PRESETS['tight-aggressive'];

  it('isolates a premium in a limped pot instead of checking it back', () => {
    const legal = la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 200, maxRaiseTo: STACK });
    const v = preflopView('BB', [c('Ac'), c('Ad')], {
      actionHistory: [publicCall(2, 0), publicCall(3, 1)],
      legalActions: legal,
      actionSeq: 2,
    });
    expect(derivePreflopContext(v).spot).toBe('limped');
    const choice = choosePreflopIntent(v, tag, () => 0.99);
    expect(choice.intent).toBe('raise');
    // A trash hand in the same spot checks, never raises.
    const trash = preflopView('BB', [c('7c'), c('2d')], {
      actionHistory: [publicCall(2, 0), publicCall(3, 1)],
      legalActions: legal,
      actionSeq: 2,
    });
    const d = new RulePolicy({
        kind: 'tight-aggressive',
        seed: 1,
        params: legacyParams('tight-aggressive'),
      }).decide(trash);
    expect(d.action).toEqual({ type: 'check' });
  });

  it('plays a cold open+3bet conservatively (folds JJ to a 4bet, continues QQ+)', () => {
    const history = [publicRaise(2, 300, 0), publicRaise(3, 900, 1)];
    const cold = preflopView('CO', [c('Jc'), c('Jd')], { actionHistory: history, actionSeq: 2 });
    expect(derivePreflopContext(cold).spot).toBe('facing3BetCold');
    expect(choosePreflopIntent(cold, tag, () => 0.99).intent).toBe('call');

    const fourBet = [
      publicRaise(2, 300, 0),
      publicRaise(7, 900, 1), // hero CO 3-bets
      publicRaise(2, 2500, 2),
    ];
    const qq = preflopView('CO', [c('Qc'), c('Qd')], { actionHistory: fourBet, actionSeq: 3 });
    expect(derivePreflopContext(qq).spot).toBe('facing4BetPlus');
    expect(choosePreflopIntent(qq, tag, () => 0.99).intent).toBe('fold');

    const aa = preflopView('CO', [c('Ac'), c('Ad')], { actionHistory: fourBet, actionSeq: 3 });
    expect(choosePreflopIntent(aa, tag, () => 0.99).intent).toBe('raise');
  });
});

// ---------------------------------------------------------------------------
// scaling semantics (P2)
// ---------------------------------------------------------------------------

describe('RulePolicy: scaling semantics', () => {
  it('keeps raise + call <= 1 after style scaling', () => {
    const v = preflopView('BTN', [c('Ac'), c('5c')], {
      actionHistory: [publicRaise(2, 300, 0)],
      actionSeq: 3,
    });
    // These style knobs are the legacy marginal-open mechanism; pin the engine.
    const choice = choosePreflopIntent(v, legacyParams('loose-aggressive'), () => 0.5);
    expect(choice.frequencies.raise + choice.frequencies.call).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('makes loose styles genuinely wider than tight-aggressive on marginal hands', () => {
    const q4s = preflopView('BTN', [c('Qc'), c('4c')], { actionSeq: 0 });
    const raiseRate = (kind: PolicyKind) =>
      choosePreflopIntent(q4s, legacyParams(kind), () => 0.5).frequencies.raise;
    const tag = raiseRate('tight-aggressive');
    const lag = raiseRate('loose-aggressive');
    const station = raiseRate('calling-station');
    const random = raiseRate('constrained-random');
    expect(tag).toBe(0);
    expect(lag).toBeGreaterThan(0.3);
    expect(station).toBeGreaterThan(0);
    expect(random).toBeGreaterThan(0);
  });

  it('applies the multiway discount to bluffs only, not value', () => {
    const tag = legacyParams('tight-aggressive');
    const bluff = [c('Ac'), c('5c')]; // A5s: a weighted 3-bet bluff
    const single = choosePreflopIntent(
      preflopView('BTN', bluff, { actionHistory: [publicRaise(2, 300, 0)], actionSeq: 3 }),
      tag,
      () => 0.5,
    ).frequencies;
    const multi = choosePreflopIntent(
      preflopView('BTN', bluff, { actionHistory: [publicRaise(2, 300, 0), publicCall(3, 1)], actionSeq: 3 }),
      tag,
      () => 0.5,
    ).frequencies;
    expect(single.raise).toBeGreaterThan(0);
    expect(multi.raise).toBeLessThan(single.raise);
    // Value AA keeps raising even in the multiway pot.
    const aa = choosePreflopIntent(
      preflopView('BTN', [c('Ac'), c('Ad')], {
        actionHistory: [publicRaise(2, 300, 0), publicCall(3, 1)],
        actionSeq: 3,
      }),
      tag,
      () => 0.999,
    ).frequencies;
    expect(aa).toEqual({ raise: 1, call: 0 });
  });

  it('orders style widths LAG > station > random > TAG on every position', () => {
    const combos = allCombos();
    const width = (pos: Pos, kind: PolicyKind) => {
      let sum = 0;
      for (const cards of combos) {
        sum += choosePreflopIntent(preflopView(pos, cards), legacyParams(kind), () => 0.5).frequencies.raise;
      }
      return sum;
    };
    for (const pos of ['UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB'] as Pos[]) {
      const tag = width(pos, 'tight-aggressive');
      const lag = width(pos, 'loose-aggressive');
      const station = width(pos, 'calling-station');
      const random = width(pos, 'constrained-random');
      expect(lag).toBeGreaterThan(station);
      expect(station).toBeGreaterThan(random);
      expect(random).toBeGreaterThan(tag);
    }
  });

  it('keeps raise + call <= 1 for every style and every hand class', () => {
    const combos = allCombos();
    for (const kind of KINDS) {
      for (const cards of combos) {
        const open = choosePreflopIntent(preflopView('BTN', cards), legacyParams(kind), () => 0.5).frequencies;
        expect(open.raise + open.call).toBeLessThanOrEqual(1 + 1e-9);
        const facing = choosePreflopIntent(
          preflopView('BTN', cards, { actionHistory: [publicRaise(2, 300, 0)], actionSeq: 1 }),
          legacyParams(kind),
          () => 0.5,
        ).frequencies;
        expect(facing.raise + facing.call).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// rule config key order (P2)
// ---------------------------------------------------------------------------

describe('parseRuleConfig', () => {
  it('is invariant to JSON key order and lets explicit params win over rules', () => {
    const a = parseRuleConfig('tight-aggressive', '{"engine":"rules-v1","preflopScale":0.5,"rules":"lag"}');
    const b = parseRuleConfig('tight-aggressive', '{"rules":"lag","preflopScale":0.5,"engine":"rules-v1"}');
    expect(a.params).toEqual(b.params);
    expect(a.params.preflopScale).toBe(0.5); // explicit beats the lag preset
    expect(a.params.threeBetScale).toBe(RULE_PRESETS['loose-aggressive'].threeBetScale);
  });
});

// ---------------------------------------------------------------------------
// legality
// ---------------------------------------------------------------------------

describe('RulePolicy: legality', () => {
  it('never returns an illegal action across styles / streets / legal shapes', () => {
    const hands: DecisionHand[] = [
      hand([c('Ac'), c('Ad')]),
      hand([c('2c'), c('2d')]),
      hand([c('7c'), c('2d')]),
      hand([c('Ah'), c('Kh')], { street: 'flop', board: [c('Qh'), c('Jh'), c('Th')] }),
      hand([c('Qs'), c('Js')], { street: 'turn', board: [c('2d'), c('7c'), c('9h'), c('Kd')] }),
    ];
    const legals = [
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 20, maxRaiseTo: 100 }),
      la({ canCheck: false, canCall: true, canRaise: false, callAmount: 10 }),
      la({ canCheck: false, canCall: true, canRaise: true, minRaiseTo: 40, maxRaiseTo: 40, callAmount: 20 }),
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: false, canBet: false }),
      la({ canCheck: false, canCall: true, canRaise: true, minRaiseTo: 60, maxRaiseTo: 500, callAmount: 50 }),
    ];
    for (const kind of KINDS) {
      const policy = new RulePolicy({ kind, seed: 5 });
      for (const h of hands) {
        for (const legal of legals) {
          const d = policy.decide(
            view({ legalActions: legal, hand: h, potOdds: odds(), seatOrder: SEAT_ORDER, actionSeq: 4 }),
          );
          assertLegal(d, legal);
        }
      }
    }
  });

  it('passes the shared legalActions()/applyAction() re-check, even malformed', () => {
    const malformed: DecisionLegalActions[] = [
      la({ canCheck: false, canCall: true, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 }),
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 0, maxRaiseTo: 0 }),
      la({ canCheck: false, canCall: true, canRaise: true, callAmount: 10, minRaiseTo: 100, maxRaiseTo: 40 }),
      la({ canCheck: false, canCall: true, canRaise: true, callAmount: 20, minRaiseTo: 40, maxRaiseTo: 40 }),
      la({ canCheck: false, canCall: false, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 }),
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 20, maxRaiseTo: 100 }),
      la({ canCheck: false, canCall: true, canRaise: true, callAmount: 50, minRaiseTo: 60, maxRaiseTo: 500 }),
    ];
    const hands = [
      hand([c('Ac'), c('Ad')], { mySeat: 8 }),
      hand([c('7c'), c('2d')], { mySeat: 8 }),
      hand([c('Ah'), c('Kh')], { mySeat: 8, street: 'flop', board: [c('Qh'), c('Jh'), c('2c')] }),
    ];
    for (const kind of KINDS) {
      const policy = new RulePolicy({ kind, seed: 9 });
      for (const legal of malformed) {
        for (const h of hands) {
          const d = policy.decide(
            view({ legalActions: legal, hand: h, potOdds: odds(), seatOrder: SEAT_ORDER, me: seat({ seat: h.mySeat ?? 8 }) }),
          );
          assertSharedLegal(d, legal);
        }
      }
    }
  });

  it('honours canBet vs canRaise independently', () => {
    const betOnly = la({ canCheck: true, canCall: false, callAmount: 0, canBet: true, canRaise: false, minRaiseTo: 20, maxRaiseTo: 100 });
    const raiseOnly = la({ canCheck: false, canCall: true, callAmount: 20, canBet: false, canRaise: true, minRaiseTo: 40, maxRaiseTo: 200 });
    const strong = hand([c('Ac'), c('Ad')], { mySeat: 8, pot: 50 });
    const vBet = view({ legalActions: betOnly, hand: strong, potOdds: odds(), seatOrder: SEAT_ORDER });
    const vRaise = view({
      legalActions: raiseOnly,
      hand: strong,
      potOdds: odds({ callAmount: 20, pot: 50, potOdds: 20 / 70, breakEvenEquity: 20 / 70 }),
      seatOrder: SEAT_ORDER,
    });
    for (const kind of KINDS) {
      const policy = new RulePolicy({ kind, seed: 2 });
      const b = policy.decide(vBet);
      assertLegal(b, betOnly);
      assertSharedLegal(b, betOnly);
      const r = policy.decide(vRaise);
      assertLegal(r, raiseOnly);
      assertSharedLegal(r, raiseOnly);
    }
  });

  it('throws only when asked to act without legal actions', () => {
    const policy = new RulePolicy();
    expect(() => policy.decide(view())).toThrow(/out of turn/);
  });
});

// ---------------------------------------------------------------------------
// reproducibility & mixed frequencies
// ---------------------------------------------------------------------------

describe('RulePolicy: seeded reproducibility', () => {
  const facingUtgOpen = (actionSeq: number) =>
    preflopView('BTN', [c('Ac'), c('5c')], {
      actionSeq,
      actionHistory: [publicRaise(2, 300, 0)],
      potOdds: odds({ callAmount: 300, pot: 450, potOdds: 300 / 750, breakEvenEquity: 300 / 750 }),
    });

  it('same view + seed decides identically 1000 times', () => {
    const policy = new RulePolicy({ kind: 'tight-aggressive', seed: 7 });
    const v = facingUtgOpen(3);
    const first = policy.decide(v);
    for (let i = 0; i < 1000; i++) expect(policy.decide(v)).toEqual(first);
    expect(new RulePolicy({ kind: 'tight-aggressive', seed: 7 }).decide(v)).toEqual(first);
  });

  it('different actionSeq values produce a mixed set of actions', () => {
    const policy = new RulePolicy({ kind: 'tight-aggressive', seed: 7 });
    const seen = new Set<string>();
    for (let s = 0; s < 1000; s++) seen.add(policy.decide(facingUtgOpen(s)).action.type);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('is order-independent: interleaving decisions cannot change a result', () => {
    const views = Array.from({ length: 100 }, (_, i) => facingUtgOpen(i));
    // Reference: each view decided by its own identical policy.
    const reference = views.map((v) => new RulePolicy({ seed: 3 }).decide(v));
    // A single policy processes the same views in a seeded shuffled order.
    const order = [...views.keys()];
    const rng = mulberry32(0xabc123);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = order[i]!;
      order[i] = order[j]!;
      order[j] = tmp;
    }
    const policy = new RulePolicy({ seed: 3 });
    const outOfOrder: PolicyDecision[] = new Array(views.length);
    for (const idx of order) outOfOrder[idx] = policy.decide(views[idx]!);
    expect(outOfOrder).toEqual(reference);
  });
});

// ---------------------------------------------------------------------------
// resolvePolicy dispatch
// ---------------------------------------------------------------------------

describe('resolvePolicy rules-v1 opt-in', () => {
  it('keeps the legacy ScriptedPolicy / StylePolicy behaviour untouched', () => {
    expect(resolvePolicy('tight-aggressive').policy.name).toBe('scripted-tight-aggressive');
    expect(resolvePolicy('tight-aggressive', '').policy.name).toBe('scripted-tight-aggressive');
    expect(resolvePolicy('loose-aggressive').policy.name).toBe('style-loose-aggressive');
    expect(resolvePolicy('tight-aggressive', JSON.stringify({ valueRaiseFraction: 0.9 })).policy.name).toBe(
      'style-tight-aggressive',
    );
  });

  it('selects RulePolicy only when engine is rules-v1', () => {
    const r = resolvePolicy('tight-aggressive', JSON.stringify({ engine: 'rules-v1' }));
    expect(r.kind).toBe('tight-aggressive');
    expect(r.policy.name).toBe('rules-v1');
    const lag = resolvePolicy('tight-aggressive', JSON.stringify({ engine: 'rules-v1', rules: 'lag' }));
    expect(lag.policy.name).toBe('rules-v1');
  });

  it('never throws on invalid rules fields and reports them', () => {
    const r = resolvePolicy(
      'tight-aggressive',
      JSON.stringify({ engine: 'rules-v1', preflopScale: 9, bogus: 1, rules: 'nope' }),
    );
    expect(r.policy.name).toBe('rules-v1');
    expect(r.warnings.join(' ')).toMatch(/preflopScale/);
    expect(r.warnings.join(' ')).toMatch(/bogus/);
    expect(r.warnings.join(' ')).toMatch(/unknown rules preset/);
  });

  it('plays a legal postflop fallback through the resolver', () => {
    const policy = resolvePolicy('loose-aggressive', JSON.stringify({ engine: 'rules-v1' }), {
      seed: 4,
    }).policy as RulePolicy;
    const legal = la({ canCheck: false, canCall: true, canRaise: true, callAmount: 50, minRaiseTo: 60, maxRaiseTo: 500 });
    const d = policy.decide(
      view({
        legalActions: legal,
        hand: hand([c('Qs'), c('Js')], { street: 'flop', board: [c('2d'), c('7c'), c('9h')] }),
        potOdds: odds({ callAmount: 50, pot: 200, potOdds: 50 / 250, breakEvenEquity: 50 / 250 }),
        seatOrder: SEAT_ORDER,
      }),
    );
    assertLegal(d, legal);
    assertSharedLegal(d, legal);
  });
});

// ---------------------------------------------------------------------------
// preflop relative position (IP/OOP to the aggressor) and 3-bet/4-bet sizing
// ---------------------------------------------------------------------------

/** A bare view with a custom seat order, for the relative-position unit tests. */
function positionView(opts: {
  heroSeat: number;
  order: number[];
  folded?: number[];
  allIn?: number[];
}): DecisionView {
  const { heroSeat, order } = opts;
  const folded = opts.folded ?? [];
  const allIn = opts.allIn ?? [];
  return view({
    hand: hand([c('Ac'), c('Kd')], { mySeat: heroSeat }),
    me: seat({ seat: heroSeat, isMe: true, userId: 1 }),
    opponents: order
      .filter((s) => s !== heroSeat)
      .map((s) => seat({ seat: s, userId: 100 + s, folded: folded.includes(s), allIn: allIn.includes(s) })),
    seatOrder: order,
  });
}

describe('preflop relative position: heroIsIPToOpener', () => {
  it('heads-up: BTN/SB is IP to the BB, BB is OOP to the BTN/SB', () => {
    // Heads-up preflop order is [button/SB, BB] (SB acts first), but postflop
    // the BB acts first and the button/SB acts last. The BB is therefore OOP to
    // the button/SB, and the button/SB is IP to the BB.
    const hu = [0, 1];
    expect(heroIsIPToOpener(positionView({ heroSeat: 1, order: hu }), 0)).toBe(false); // BB vs BTN/SB
    expect(heroIsIPToOpener(positionView({ heroSeat: 0, order: hu }), 1)).toBe(true); // BTN/SB vs BB
  });

  it('does not flip when a third player is still active behind hero (the heroInPosition bug)', () => {
    const order = [0, 1, 2, 3, 4, 5];
    const v = positionView({ heroSeat: 4, order }); // hero CO-ish, opener seat 2, seat 5 behind
    expect(heroIsIPToOpener(v, 2)).toBe(true); // acts after the opener
    // The old postflop helper is false here because seat 5 is still active —
    // exactly the multiway mis-read this replaces.
    expect(heroInPosition(v)).toBe(false);
  });

  it('ignores an all-in third party and a folded opener state', () => {
    const order = [0, 1, 2, 3, 4, 5];
    // Third player all-in: still IP relative to the opener.
    expect(heroIsIPToOpener(positionView({ heroSeat: 4, order, allIn: [5] }), 2)).toBe(true);
    // Opener already all-in: the seat still exists in the order, so the
    // comparison stands (all-in does not erase position).
    expect(heroIsIPToOpener(positionView({ heroSeat: 4, order, allIn: [2] }), 2)).toBe(true);
    // Opener folded: same — position is about seat order, not liveness.
    expect(heroIsIPToOpener(positionView({ heroSeat: 4, order, folded: [2] }), 2)).toBe(true);
  });

  it('falls back to OOP when hero/opener is unknown or the opener is absent', () => {
    const order = [0, 1, 2, 3];
    expect(heroIsIPToOpener(positionView({ heroSeat: 3, order }), null)).toBe(false); // no opener
    expect(heroIsIPToOpener(positionView({ heroSeat: 3, order }), 3)).toBe(false); // opener == hero
    expect(heroIsIPToOpener(positionView({ heroSeat: 3, order }), 99)).toBe(false); // absent seat
    // Hero seat itself absent from the order.
    const v = view({ hand: hand([c('Ac'), c('Kd')], { mySeat: 42 }), seatOrder: order });
    expect(heroIsIPToOpener(v, 0)).toBe(false);
  });

  it('handles the blind boundaries', () => {
    const order = [0, 1, 2, 3, 4, 5];
    expect(heroIsIPToOpener(positionView({ heroSeat: 1, order }), 0)).toBe(true); // BB IP to SB
    expect(heroIsIPToOpener(positionView({ heroSeat: 0, order }), 1)).toBe(false); // SB OOP to BB
    expect(heroIsIPToOpener(positionView({ heroSeat: 0, order }), 5)).toBe(false); // SB OOP to BTN
    expect(heroIsIPToOpener(positionView({ heroSeat: 5, order }), 1)).toBe(true); // BTN IP to BB
  });

  it('lastPreflopRaiserSeat returns the aggressor hero is responding to', () => {
    const v0 = view({ actionHistory: [publicCall(4, 0), publicRaise(2, 250, 1)] });
    expect(lastPreflopRaiserSeat(v0)).toBe(2);
    // A later raise overrides the opener -> the 3-bettor.
    const v1 = view({
      actionHistory: [publicRaise(2, 250, 0), publicCall(4, 1), publicRaise(6, 750, 2)],
    });
    expect(lastPreflopRaiserSeat(v1)).toBe(6);
    // No raise at all.
    expect(lastPreflopRaiserSeat(view({ actionHistory: [publicCall(4, 0)] }))).toBeNull();
    expect(lastPreflopRaiserSeat(view())).toBeNull();
  });
});

describe('preflop 3-bet / 4-bet sizing (IP 3x/2.2x, OOP 4x/2.5x)', () => {
  const tag = legacyParams('tight-aggressive');
  const policy = new RulePolicy({ kind: 'tight-aggressive', seed: 1, params: tag });
  const AA = [c('Ac'), c('Ad')];

  /** Facing-open / facing-3bet view with a controlled preflop history. */
  function sizingView(heroPos: Pos, history: PublicAction[], currentBet: number): DecisionView {
    const mySeat = POS_INDEX[heroPos];
    return preflopView(heroPos, AA, {
      actionHistory: history,
      actionSeq: history.length,
      hand: hand(AA, {
        street: 'preflop',
        buttonSeat: BUTTON,
        board: [],
        pot: 150 + currentBet,
        currentBet,
        toAct: mySeat,
        mySeat,
      }),
    });
  }

  it('3-bets 3x in position even with players still to act behind', () => {
    // Hero CO (seat 7) vs a UTG (seat 2) open; BTN (seat 8) is still active, so
    // the old `heroInPosition` would have wrongly called this OOP.
    const v = sizingView('CO', [publicRaise(2, 250, 0)], 250);
    expect(heroInPosition(v)).toBe(false);
    const d = policy.decide(v);
    expect(d.action).toEqual({ type: 'raise', amount: 750 }); // 3 x 250
  });

  it('3-bets 4x out of position', () => {
    // Hero BB (seat 1) vs a BTN (seat 8) open.
    const v = sizingView('BB', [publicRaise(8, 250, 0)], 250);
    expect(heroIsIPToOpener(v, 8)).toBe(false);
    const d = policy.decide(v);
    expect(d.action).toEqual({ type: 'raise', amount: 1000 }); // 4 x 250
  });

  it('4-bets 2.2x in position', () => {
    // Hero BTN (seat 8) opened; BB (seat 1) 3-bet to 750. BTN is IP to the BB.
    const v = sizingView('BTN', [publicRaise(8, 250, 0), publicRaise(1, 750, 1)], 750);
    expect(heroIsIPToOpener(v, 1)).toBe(true);
    const d = policy.decide(v);
    expect(d.action).toEqual({ type: 'raise', amount: 1650 }); // 2.2 x 750
  });

  it('4-bets 2.5x out of position', () => {
    // Hero SB (seat 0) opened to 300; BB (seat 1) 3-bet to 900. SB is OOP.
    const v = sizingView('SB', [publicRaise(0, 300, 0), publicRaise(1, 900, 1)], 900);
    expect(heroIsIPToOpener(v, 1)).toBe(false);
    const d = policy.decide(v);
    expect(d.action).toEqual({ type: 'raise', amount: 2250 }); // 2.5 x 900
  });
});

// ---------------------------------------------------------------------------
// heads-up: the 3-bet / 4-bet size is keyed on *postflop* position, so the BB
// (which acts first postflop) is OOP and the button/SB (which acts last) is IP.
// ---------------------------------------------------------------------------

describe('preflop heads-up 3-bet / 4-bet sizing (postflop position)', () => {
  const tag = legacyParams('tight-aggressive');
  const policy = new RulePolicy({ kind: 'tight-aggressive', seed: 1, params: tag });
  const AA = [c('Ac'), c('Ad')];
  const HU_ORDER = [0, 1]; // seat 0 = button/SB, seat 1 = BB

  /** HU view: seat 0 is the button/SB, seat 1 the BB. AA always raises. */
  function huView(heroSeat: 0 | 1, history: PublicAction[], currentBet: number): DecisionView {
    const villainSeat = heroSeat === 0 ? 1 : 0;
    const heroCommitted = heroSeat === 0 ? 50 : 100;
    const callAmount = currentBet - heroCommitted;
    return view({
      room: { id: 'r1', name: 'hu', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
      hand: hand(AA, {
        street: 'preflop',
        buttonSeat: 0,
        board: [],
        pot: 150 + currentBet,
        currentBet,
        toAct: heroSeat,
        mySeat: heroSeat,
      }),
      me: seat({
        seat: heroSeat,
        userId: 1,
        displayName: 'hero',
        isMe: true,
        stack: 10_000,
        committed: heroCommitted,
        total: heroCommitted,
      }),
      opponents: [
        seat({
          seat: villainSeat,
          userId: 2,
          stack: 10_000,
          committed: currentBet,
          total: currentBet,
        }),
      ],
      legalActions: la({
        canCheck: false,
        canCall: true,
        callAmount,
        canRaise: true,
        minRaiseTo: currentBet * 2,
        maxRaiseTo: 10_000,
      }),
      potOdds: odds({
        callAmount,
        pot: 150 + currentBet,
        potOdds: callAmount / (150 + currentBet),
        breakEvenEquity: callAmount / (150 + currentBet),
      }),
      actionHistory: history,
      actionSeq: history.length,
      seatOrder: HU_ORDER,
    });
  }

  it('BB is OOP postflop and 3-bets 4x versus a BTN/SB open', () => {
    const v = huView(1, [publicRaise(0, 300, 0)], 300);
    expect(heroIsIPToOpener(v, 0)).toBe(false);
    expect(policy.decide(v).action).toEqual({ type: 'raise', amount: 1200 }); // 4 x 300
  });

  it('BTN/SB is IP postflop and 3-bets 3x versus a BB raise over its limp', () => {
    const v = huView(0, [publicCall(0, 0), publicRaise(1, 300, 1)], 300);
    expect(heroIsIPToOpener(v, 1)).toBe(true);
    expect(policy.decide(v).action).toEqual({ type: 'raise', amount: 900 }); // 3 x 300
  });

  it('BB is OOP postflop and 4-bets 2.5x', () => {
    const v = huView(1, [publicCall(0, 0), publicRaise(1, 300, 1), publicRaise(0, 900, 2)], 900);
    expect(heroIsIPToOpener(v, 0)).toBe(false);
    expect(policy.decide(v).action).toEqual({ type: 'raise', amount: 2250 }); // 2.5 x 900
  });

  it('BTN/SB is IP postflop and 4-bets 2.2x', () => {
    const v = huView(0, [publicRaise(0, 300, 0), publicRaise(1, 900, 1)], 900);
    expect(heroIsIPToOpener(v, 1)).toBe(true);
    expect(policy.decide(v).action).toEqual({ type: 'raise', amount: 1980 }); // 2.2 x 900
  });
});
