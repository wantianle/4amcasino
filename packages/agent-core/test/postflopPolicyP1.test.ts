import { describe, expect, it } from 'vitest';
import { cardFromName, type CardId } from '@4am/shared';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionPotOdds,
  DecisionSeat,
  DecisionView,
} from '../src/decisionView.js';
import { estimateEquity } from '../src/equity.js';
import {
  P2_ALL_OFF,
  PostflopPolicy,
  buildVillainRange,
  facingVillainRange,
  evaluateHand,
  flushLayerOf,
  heroFlushExposed,
  isExposedOverpair,
  isOverpair,
  villainStrengthTier,
} from '../src/postflopPolicy.js';
import { deriveRulesSeed } from '../src/rulesSeed.js';
import { RULE_PRESETS } from '../src/ruleStyles.js';

const c = (n: string) => cardFromName(n);
const SEED = 7;
// P1 behaviour is locked with P2 explicitly off (the default since the
// 2026-10-06 A/B revert); the explicit constant keeps the isolation explicit.
const policy = () =>
  new PostflopPolicy({ params: RULE_PRESETS['tight-aggressive'], seed: SEED, p2: P2_ALL_OFF });

// ---------------------------------------------------------------------------
// view builders (mirrors the P0 suite so the two lanes are comparable)
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
  const villain = seat({ seat: 0, committed: call, total: call, allIn: opts.allIn ?? false });
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

/** An unopened-pot view where hero may check or bet (used for value-bet rates). */
function unopenedView(
  hole: CardId[],
  board: CardId[],
  pot: number,
  seq: number,
): DecisionView {
  const villain = seat({ seat: 0 });
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
    minRaiseTo: 10,
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
  continue: number;
  raise: number;
}

/** Bet frequency over `n` distinct actionSeq seeds (unopened pots). */
function betRate(factory: (seq: number) => DecisionView, p: PostflopPolicy, n = 400): number {
  let bet = 0;
  for (let seq = 0; seq < n; seq++) {
    if (p.decide(factory(seq)).action.type === 'bet') bet++;
  }
  return bet / n;
}

/** Fold / continue / raise rates over `n` distinct actionSeq seeds. */
function ratesFor(
  factory: (seq: number) => DecisionView,
  p: PostflopPolicy,
  n = 400,
): Rates {
  let fold = 0;
  let raise = 0;
  for (let seq = 0; seq < n; seq++) {
    const action = p.decide(factory(seq)).action.type;
    if (action === 'fold') fold++;
    if (action === 'raise' || action === 'bet') raise++;
  }
  return { fold: fold / n, continue: 1 - fold / n, raise: raise / n };
}

/** Fraction of a weighted villain range's total weight that is a made flush. */
function flushShare(hole: CardId[], board: CardId[]): number {
  let flush = 0;
  let total = 0;
  for (const combo of buildVillainRange(hole, board, 'value-heavy')) {
    total += combo.weight;
    if (evaluateHand(combo.cards, board).category === 5) flush += combo.weight;
  }
  return flush / total;
}

const FOUR_FLUSH = [c('5s'), c('7s'), c('9s'), c('Js'), c('2d')];
const THREE_FLUSH = [c('Qh'), c('9h'), c('4h'), c('2c')];
const DRY = [c('Kh'), c('7d'), c('2c')];
const SIZES = [
  { name: 'half', pot: 150, call: 50, allIn: false },
  { name: 'pot', pot: 200, call: 100, allIn: false },
  { name: 'overbet', pot: 300, call: 200, allIn: false },
  { name: 'all-in', pot: 300, call: 200, allIn: true },
] as const;

// ---------------------------------------------------------------------------

describe('postflop P1: flush layer (pure)', () => {
  it('splits a four-flush board into nut / second / middle / low by fifth card', () => {
    const layer = (spade: string) => flushLayerOf([c(spade), c('8d')], FOUR_FLUSH);
    expect(layer('As')).toBe('nut');
    expect(layer('Ks')).toBe('second');
    expect(layer('Qs')).toBe('middle');
    expect(layer('Ts')).toBe('middle');
    expect(layer('8s')).toBe('middle');
    expect(layer('6s')).toBe('low');
    expect(layer('4s')).toBe('low');
    expect(layer('3s')).toBe('low');
    // No card of the suit cannot make a flush on a four-flush board.
    expect(flushLayerOf([c('8d'), c('8c')], FOUR_FLUSH)).toBeNull();
  });

  it('layers a three-flush board from the two same-suit hole cards', () => {
    const layer = (a: string, b: string) => flushLayerOf([c(a), c(b)], THREE_FLUSH);
    expect(layer('Ah', 'Kh')).toBe('nut'); // A-K high
    expect(layer('Ah', 'Jh')).toBe('second'); // A-J high
    expect(layer('Kh', 'Jh')).toBe('middle');
    expect(layer('Jh', 'Th')).toBe('middle');
    expect(layer('Th', '8h')).toBe('low'); // Q T 9 8 4 = 25th of 45
    expect(layer('8h', '5h')).toBe('low');
    expect(layer('5h', '3h')).toBe('low');
    // A single same-suit card is one short of a three-flush-board flush.
    expect(flushLayerOf([c('Ah'), c('2d')], THREE_FLUSH)).toBeNull();
  });

  it('orders three-flush completions lexicographically, not by rank sum', () => {
    const layer = (a: string, b: string) => flushLayerOf([c(a), c(b)], THREE_FLUSH);
    // `Qh9h4h` + `Kh2h` = K Q 9 4 2 (K-high, 17th of 45) -> middle. A rank-sum
    // key scores its low kickers below the T/J flushes and wrongly reports low.
    expect(layer('Kh', '2h')).toBe('middle');
    // `Jh3h` = Q J 9 3 2 -> middle by position; rank sum wrongly reports low.
    expect(layer('Jh', '3h')).toBe('middle');
    // `Th8h` = Q T 9 8 4 (25th of 45) -> low; rank sum wrongly reports middle.
    expect(layer('Th', '8h')).toBe('low');
    // A-high vs K-high despite a lower rank sum: A Q 9 4 2 beats K Q J 9 4
    // (`A+2 < K+J`), the exact case the previous sum key mis-ranked. Both sit in
    // `middle`, but the mismatching pairs above pin the lexicographic order.
    expect(layer('Ah', '2h')).toBe('middle');
    expect(layer('Kh', 'Jh')).toBe('middle');
  });

  it('keeps category priority: straight flush / quads / full house are not flushes', () => {
    // 7s 8s 9s + Ts Js = J-high straight flush; must not be treated as a plain
    // (and mis-layerable) flush.
    const sfBoard = [c('7s'), c('8s'), c('9s'), c('2d'), c('3c')];
    expect(villainStrengthTier([c('Ts'), c('Js')], sfBoard)).toBe(1);
    // Quads on a board that also carries three of a suit.
    const quadBoard = [c('5s'), c('5d'), c('5h'), c('2c'), c('3d')];
    expect(villainStrengthTier([c('5c'), c('Kd')], quadBoard)).toBe(1);
    // A full house out-ranks every flush on a paired, suited board.
    const fhBoard = [c('5s'), c('5d'), c('Ks'), c('2s'), c('7h')];
    expect(villainStrengthTier([c('5h'), c('Kd')], fhBoard)).toBe(1);
  });

  it('returns the nuts for a five-flush board (hero plays the board flush)', () => {
    const board = [c('2s'), c('5s'), c('8s'), c('Js'), c('As')];
    expect(flushLayerOf([c('Ks'), c('3s')], board)).toBe('nut');
    expect(flushLayerOf([c('Kd'), c('3c')], board)).toBe('nut'); // board plays
  });
});

describe('postflop P1: villain flush stratification', () => {
  it('weights a made flush by layer, keeping full house+ at the top', () => {
    expect(villainStrengthTier([c('As'), c('8d')], FOUR_FLUSH)).toBe(1);
    expect(villainStrengthTier([c('Ks'), c('8d')], FOUR_FLUSH)).toBe(0.97);
    expect(villainStrengthTier([c('Qs'), c('8d')], FOUR_FLUSH)).toBe(0.93);
    expect(villainStrengthTier([c('3s'), c('8d')], FOUR_FLUSH)).toBe(0.88);
    // A full house still out-ranks every flush layer.
    const paired = [c('5s'), c('5d'), c('5h'), c('Js'), c('2s')];
    expect(villainStrengthTier([c('Js'), c('Jd')], paired)).toBe(1);
  });

  it('orders large-sample stratified equity nut > second > middle > low', () => {
    const eq = (spade: string) =>
      estimateEquity({
        hole: [c(spade), c('8d')],
        board: FOUR_FLUSH,
        opponents: 1,
        samples: 2000,
        seed: 5,
        villainRange: { combos: buildVillainRange([c(spade), c('8d')], FOUR_FLUSH, 'balanced') },
      }).equity;
    const nut = eq('As');
    const second = eq('Ks');
    const middle = eq('Qs');
    const low = eq('3s');
    expect(nut).toBeGreaterThan(second);
    expect(second).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(low);
    expect(nut).toBeGreaterThan(0.9);
    expect(low).toBeLessThan(0.7);
  });
});

describe('postflop P1: hero flush exposure & blocker equity correction', () => {
  it('flags an overpair with no card of the flush suit', () => {
    expect(heroFlushExposed([c('Kd'), c('Kc')], FOUR_FLUSH)).toBe(true);
    expect(heroFlushExposed([c('Ks'), c('Kd')], FOUR_FLUSH)).toBe(false);
    expect(heroFlushExposed([c('Ks'), c('Kd')], THREE_FLUSH)).toBe(true);
    expect(heroFlushExposed([c('Kh'), c('Kd')], THREE_FLUSH)).toBe(false);
    expect(heroFlushExposed([c('Ks'), c('Qd')], DRY)).toBe(false); // not suited
  });

  it('a nut/second blocker lightens the flush range; no suit tilts it heavier', () => {
    const nut = flushShare([c('As'), c('8d')], FOUR_FLUSH);
    const second = flushShare([c('Ks'), c('8d')], FOUR_FLUSH);
    const low = flushShare([c('3s'), c('8d')], FOUR_FLUSH);
    const none = flushShare([c('Kd'), c('Kc')], FOUR_FLUSH);
    expect(nut).toBeLessThan(second);
    expect(second).toBeLessThan(low);
    expect(low).toBeLessThan(none);
    // The correction is monotonic in blocker strength.
    expect(none - nut).toBeGreaterThan(0.02);
  });

  it('the same correction flows through facingVillainRange (deterministic)', () => {
    const view = facingView([c('As'), c('8d')], FOUR_FLUSH, 200, 100);
    const hole = view.hand!.myCards;
    const range = facingVillainRange(view, hole, 100, 100);
    expect(range.combos).toEqual(facingVillainRange(view, hole, 100, 100).combos);
    expect(range.combos!.length).toBeGreaterThan(0);
  });
});

describe('postflop P1: user case a — river four-flush vs all-in', () => {
  const river = (spade: string, seq: number) =>
    facingView([c(spade), c('8d')], FOUR_FLUSH, 200, 100, { actionSeq: seq }, { allIn: true });

  it('the smallest flush never calls; higher flush ranks continue monotonically', () => {
    const p = policy();
    const spades = ['As', 'Ks', 'Qs', 'Ts', '8s', '6s', '4s', '3s'];
    const cont = spades.map((s) => ratesFor((seq) => river(s, seq), p, 400).continue);
    // never save the minimum flush
    expect(cont[spades.length - 1]!).toBeLessThanOrEqual(0.05);
    expect(cont[0]!).toBeGreaterThanOrEqual(0.95);
    // Monotone in flush strength: a stronger flush never continues *less* than a
    // weaker one, within an **explicit heuristic tolerance** of 5% at the
    // fold/call line. This is a deterministic seeded sweep, not a statistical
    // proof, so a tolerance is unavoidable; it was tightened from the original
    // 15% after confirming the step-3 engine holds it (the extremes are still
    // >0.8 apart, so the bound is not vacuous). Comparing only adjacent ranks
    // cannot work here: the available spade ranks are not evenly spaced and the
    // whole 0.95 range is covered in 7 steps, so some genuine step exceeds 5%.
    // The global pairwise form below fails loudly if a weaker flush ever
    // continues materially more than a stronger one.
    for (let strong = 0; strong < cont.length; strong++) {
      for (let weak = strong + 1; weak < cont.length; weak++) {
        expect(cont[strong]!, `${spades[strong]} vs ${spades[weak]}`).toBeGreaterThanOrEqual(
          cont[weak]! - 0.05,
        );
      }
    }
    // and the extremes are far apart, so the pass is not vacuous
    expect(cont[0]! - cont[spades.length - 1]!).toBeGreaterThan(0.8);
  });

  it('layers the all-in continue rate nut ≥ second ≥ middle ≥ low per size', () => {
    const p = policy();
    const group = { nut: 'As', second: 'Ks', middle: 'Qs', low: '3s' } as const;
    for (const size of SIZES) {
      const cont = (spade: string) =>
        ratesFor(
          (seq) =>
            facingView([c(spade), c('8d')], FOUR_FLUSH, size.pot, size.call, { actionSeq: seq }, { allIn: size.allIn }),
          p,
          300,
        ).continue;
      const nut = cont(group.nut);
      const second = cont(group.second);
      const middle = cont(group.middle);
      const low = cont(group.low);
      expect(nut, `${size.name} nut`).toBeGreaterThanOrEqual(0.95);
      expect(nut).toBeGreaterThanOrEqual(second);
      expect(second).toBeGreaterThanOrEqual(middle);
      expect(middle).toBeGreaterThanOrEqual(low);
      if (size.name !== 'half') {
        // A low flush is never a call for a big bet / shove.
        expect(low, `${size.name} low`).toBeLessThanOrEqual(0.05);
      }
    }
  });
});

describe('postflop P1: user case b — three-flush turn, KK no heart', () => {
  const noHeart = [c('Ks'), c('Kd')];
  const withHeart = [c('Kh'), c('Kd')];

  it('discounts the unprotected KK and rewards the heart blocker vs a big bet', () => {
    const p = policy();
    const over = (hole: CardId[], seq: number) =>
      facingView(hole, THREE_FLUSH, 300, 200, { actionSeq: seq });
    const no = ratesFor((seq) => over(noHeart, seq), p, 400);
    const with_ = ratesFor((seq) => over(withHeart, seq), p, 400);
    // P0 measured ~0.30 continue for the no-heart hand; P1 must be lower.
    expect(no.continue).toBeLessThan(0.25);
    expect(with_.continue).toBeGreaterThan(0.8);
    expect(with_.continue - no.continue).toBeGreaterThan(0.5);
    expect(no.raise).toBeLessThan(with_.raise);
  });

  it('matrix overpair {with/without suit} × {half/pot/overbet/all-in}', () => {
    const p = policy();
    for (const size of SIZES) {
      const run = (hole: CardId[]) =>
        ratesFor(
          (seq) =>
            facingView(hole, THREE_FLUSH, size.pot, size.call, { actionSeq: seq }, { allIn: size.allIn }),
          p,
          300,
        );
      const no = run(noHeart);
      const with_ = run(withHeart);
      // The suit-holding hand is a clear continue at every size; the blocker
      // means its raise frequency (aggression) is always higher.
      expect(with_.continue, `${size.name} with-suit`).toBeGreaterThanOrEqual(0.95);
      expect(with_.raise, `${size.name} raise layering`).toBeGreaterThan(no.raise);
      // Unprotected KK is held back more the larger the bet.
      expect(no.continue, `${size.name} no-suit`).toBeLessThanOrEqual(with_.continue);
      if (size.name === 'half') expect(no.continue).toBeGreaterThanOrEqual(0.9);
      if (size.name === 'pot') {
        expect(no.continue).toBeGreaterThan(0.5);
        expect(no.continue).toBeLessThan(0.95);
      }
      if (size.name === 'overbet' || size.name === 'all-in') {
        expect(no.continue, `${size.name} no-suit folds`).toBeLessThanOrEqual(0.3);
      }
    }
  });
});

describe('postflop P1: reproducibility', () => {
  const cases: [string, CardId[], CardId[]][] = [
    ['unprotected KK', [c('Ks'), c('Kd')], THREE_FLUSH],
    ['nut blocker', [c('As'), c('8d')], FOUR_FLUSH],
    ['small flush', [c('3s'), c('8d')], FOUR_FLUSH],
  ];

  it('same view + seed decides identically (P1 range tilt included)', () => {
    const p = policy();
    for (const [, hole, board] of cases) {
      const view = () => facingView(hole, board, 300, 200, { actionSeq: 3 });
      const first = p.decide(view());
      for (let i = 0; i < 100; i++) expect(p.decide(view())).toEqual(first);
    }
  });

  it('the blocker-corrected range is deterministic across repeated builds', () => {
    for (const [, hole, board] of cases) {
      expect(buildVillainRange(hole, board, 'value-heavy')).toEqual(
        buildVillainRange(hole, board, 'value-heavy'),
      );
    }
    // Deriving equity twice from the same seed/range is stable.
    const hole = [c('Ks'), c('Kd')];
    const once = estimateEquity({
      hole,
      board: THREE_FLUSH,
      opponents: 1,
      samples: 128,
      seed: deriveRulesSeed(SEED, facingView(hole, THREE_FLUSH, 300, 200, { actionSeq: 3 })),
      villainRange: facingVillainRange(
        facingView(hole, THREE_FLUSH, 300, 200, { actionSeq: 3 }),
        hole,
        100,
        200,
      ),
    }).equity;
    const twice = estimateEquity({
      hole,
      board: THREE_FLUSH,
      opponents: 1,
      samples: 128,
      seed: deriveRulesSeed(SEED, facingView(hole, THREE_FLUSH, 300, 200, { actionSeq: 3 })),
      villainRange: facingVillainRange(
        facingView(hole, THREE_FLUSH, 300, 200, { actionSeq: 3 }),
        hole,
        100,
        200,
      ),
    }).equity;
    expect(once).toBe(twice);
  });
});

// ---------------------------------------------------------------------------
// P1 rev2: the exposed discount is scoped to overpairs only
// ---------------------------------------------------------------------------

describe('postflop P1: isOverpair (pure)', () => {
  const op = (hole: CardId[], board: CardId[]) => isOverpair(hole, board, evaluateHand(hole, board));

  it('identifies a pocket pair above every board card and rejects the rest', () => {
    expect(op([c('Ad'), c('Ac')], THREE_FLUSH)).toBe(true); // AA on Q-high
    expect(op([c('Ks'), c('Kd')], THREE_FLUSH)).toBe(true); // KK on Q-high
    expect(op([c('Jd'), c('Jc')], THREE_FLUSH)).toBe(false); // underpair
    expect(op([c('Qd'), c('Qc')], THREE_FLUSH)).toBe(false); // set (pair on board)
    expect(op([c('4d'), c('4c')], THREE_FLUSH)).toBe(false); // set of 4
    expect(op([c('Qd'), c('9d')], THREE_FLUSH)).toBe(false); // two pair
    expect(op([c('Ad'), c('Kd')], THREE_FLUSH)).toBe(false); // unpaired high cards
    expect(op([c('Ad'), c('Ac')], DRY)).toBe(true); // suit-agnostic
    expect(op([c('9d'), c('9c')], DRY)).toBe(false); // 9 below a K-high board
    expect(op([c('Ad')], THREE_FLUSH)).toBe(false); // needs two hole cards
    expect(op([c('Ad'), c('Ac')], [c('Kh')])).toBe(false); // board too short
  });

  it('rejects AA on a paired board (the optional-ev regression)', () => {
    // AA on QQx is two pair (aces and queens), not an overpair. The old
    // optional-`ev` signature returned true when the caller omitted `ev`; the
    // required, evaluated category now rejects it.
    const paired = [c('Qh'), c('Qd'), c('2c')];
    expect(isOverpair([c('Ad'), c('Ac')], paired, evaluateHand([c('Ad'), c('Ac')], paired))).toBe(
      false,
    );
    expect(evaluateHand([c('Ad'), c('Ac')], paired).category).toBe(2); // two pair
  });

  it('honours the evaluated category when supplied', () => {
    const setHand = [c('Qd'), c('Qc')];
    const overHand = [c('Ks'), c('Kd')];
    expect(isOverpair(setHand, THREE_FLUSH, evaluateHand(setHand, THREE_FLUSH))).toBe(false);
    expect(isOverpair(overHand, THREE_FLUSH, evaluateHand(overHand, THREE_FLUSH))).toBe(true);
  });
});

describe('postflop P1: isExposedOverpair is the explicit discount set', () => {
  const ev = (hole: CardId[], board: CardId[]) => evaluateHand(hole, board);

  it('is overpair AND no card of the board flush suit, nothing else', () => {
    // Exposed overpair: pocket pair above the board, no card of the suit.
    expect(
      isExposedOverpair([c('Kd'), c('Kc')], FOUR_FLUSH, ev([c('Kd'), c('Kc')], FOUR_FLUSH)),
    ).toBe(true);
    // Same overpair holding a card of the flush suit is NOT exposed.
    expect(
      isExposedOverpair([c('Ks'), c('Kd')], FOUR_FLUSH, ev([c('Ks'), c('Kd')], FOUR_FLUSH)),
    ).toBe(false);
    // Overpair on a dry (flushless) board is NOT exposed.
    expect(isExposedOverpair([c('Kd'), c('Kc')], DRY, ev([c('Kd'), c('Kc')], DRY))).toBe(false);
    // Two pair / set with no card of the suit are `heroFlushExposed` but must
    // NOT enter the discount set.
    expect(heroFlushExposed([c('Qd'), c('9d')], FOUR_FLUSH)).toBe(true);
    expect(
      isExposedOverpair([c('Qd'), c('9d')], FOUR_FLUSH, ev([c('Qd'), c('9d')], FOUR_FLUSH)),
    ).toBe(false);
    expect(heroFlushExposed([c('Qs'), c('Qc')], THREE_FLUSH)).toBe(true);
    expect(
      isExposedOverpair([c('Qs'), c('Qc')], THREE_FLUSH, ev([c('Qs'), c('Qc')], THREE_FLUSH)),
    ).toBe(false);
  });

  it('the exposed range tilt stays finite, positive and heavier for the no-suit hero', () => {
    const exposed = buildVillainRange([c('Kd'), c('Kc')], FOUR_FLUSH, 'balanced');
    expect(exposed.length).toBeGreaterThan(0);
    for (const combo of exposed) {
      expect(combo.cards).toHaveLength(2);
      expect(Number.isFinite(combo.weight)).toBe(true);
      expect(combo.weight).toBeGreaterThan(0);
    }
    // The no-suit hero sees a strictly heavier flush share than a suited hero
    // (the explicit tilt boundary the heuristic is documented to produce).
    expect(flushShare([c('Kd'), c('Kc')], FOUR_FLUSH)).toBeGreaterThan(
      flushShare([c('3s'), c('8d')], FOUR_FLUSH),
    );
  });
});

describe('postflop P1: exposed-overpair discount does not leak to other hands', () => {
  const noSuitKK = [c('Ks'), c('Kd')];
  const suitKK = [c('Kh'), c('Kd')];
  const setQ = [c('Qd'), c('Qc')];
  const set4 = [c('4d'), c('4c')];
  const twoPair = [c('Qd'), c('9d')];

  it('keeps set / two pair value aggression facing a big bet', () => {
    const p = policy();
    const run = (hole: CardId[]) =>
      ratesFor((seq) => facingView(hole, THREE_FLUSH, 300, 200, { actionSeq: seq }), p, 400);
    const kk = run(noSuitKK);
    const set = run(setQ);
    const setOf4 = run(set4);
    const tp = run(twoPair);
    // The exposed overpair is still the held-back bluff-catcher ...
    expect(kk.raise).toBeLessThan(0.2);
    // ... while sets / two pair keep normal value aggression (they sat near 0.21
    // when the ×0.2 discount leaked to every no-suit hand).
    expect(set.raise).toBeGreaterThan(0.45);
    expect(setOf4.raise).toBeGreaterThan(0.45);
    expect(tp.raise).toBeGreaterThan(0.4);
    expect(set.raise).toBeGreaterThan(kk.raise + 0.3);
  });

  it('keeps set / two pair value bets in an unopened pot (×0.6 is overpair-only)', () => {
    const p = policy();
    const run = (hole: CardId[]) =>
      betRate((seq) => unopenedView(hole, THREE_FLUSH, 100, seq), p, 400);
    expect(run(setQ)).toBeGreaterThan(0.85);
    expect(run(set4)).toBeGreaterThan(0.85);
    expect(run(twoPair)).toBeGreaterThan(0.85);
    // Only the unprotected overpair takes the 0.6 bet-frequency discount.
    expect(run(noSuitKK)).toBeLessThan(0.8);
    expect(run(suitKK)).toBeGreaterThan(0.85);
  });
});
