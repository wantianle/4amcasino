import { describe, expect, it } from 'vitest';
import { cardFromName, type CardId, type PlayerAction } from '@4am/shared';
import {
  type DecisionLegalActions,
  type DecisionSeat,
  type DecisionView,
  type PublicAction,
} from '../src/decisionView.js';
import {
  adaptivePreflopAvailable,
  choosePreflopIntent,
  derivePreflopContext,
} from '../src/preflopPolicy.js';
import { preflopActionOrder } from '../src/preflopCharts/index.js';
import { allHandClasses, handClassInfo } from '../src/rangeParser.js';
import { RulePolicy } from '../src/rulePolicy.js';
import { RULE_PRESETS, type RuleParams } from '../src/ruleStyles.js';

/**
 * Preflop facing-3-bet coverage (diagnostic, NOT a strategy test).
 *
 * Motivation: a production report said "almost no bot 4-bets; AA/KK/QQ/AK never
 * 4-bet". Independent diagnosis found the `FACING_3BET_4BET` table is non-empty
 * and both policy routes use it, so this test **proves the path is wired** for
 * every hand class and pins the value-raise behaviour at the extremes of
 * `behindUnacted`:
 *
 *   - AA / KK / AKs / AKo must carry a positive raise frequency and, with the
 *     legal raise available, the `RulePolicy` adapter must return a raise — i.e.
 *     the intent is not silently converted to call/fold;
 *   - QQ must carry a positive call frequency (the charts deliberately flat it
 *     rather than 4-bet it, per the reference solver table);
 *   - the value raise must not go to zero as `behindUnacted` grows (the derived
 *     taper scales non-premium participation but must keep it strictly positive,
 *     and holds AA/KK fixed).
 *
 * The 6-max view tops out at `behindUnacted = 3` (UTG opens, three seats still
 * to act), so the `0 vs 8` comparison is run on a 9-max UTG view, where the
 * natural behind count is exactly 8.
 */

const c = (n: string) => cardFromName(n);

const RANK_CHARS = '23456789TJQKA';
const SUIT_CHARS = ['c', 'd', 'h', 's'] as const;

/** One concrete combo for a canonical class key. */
function cardsFor(key: string): CardId[] {
  const info = handClassInfo(key);
  if (!info) throw new Error(`unknown hand class ${key}`);
  const hi = RANK_CHARS[info.high]!;
  const lo = RANK_CHARS[info.low]!;
  if (info.pair) return [c(`${hi}c`), c(`${hi}d`)];
  if (info.suited) return [c(`${hi}c`), c(`${lo}c`)];
  return [c(`${hi}c`), c(`${lo}d`)];
}

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 0,
    userId: 1,
    displayName: 'p',
    isMe: false,
    stack: 10_000,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    ...over,
  };
}

function act(seatNo: number, type: PlayerAction['type'], amount?: number): PublicAction {
  return {
    actionSeq: 0,
    street: 'preflop',
    seat: seatNo,
    action: { type, ...(amount === undefined ? {} : { amount }) },
    auto: false,
    ts: 0,
  };
}

/**
 * A 100BB preflop view: hero opened, villain 3-bet, hero to act. `behind` seats
 * after the hero (in preflop action order) still owe an action, which is exactly
 * what `derivePreflopContext` reads as `behindUnacted`.
 */
function facing3BetView(opts: {
  n: number;
  heroSeat: number;
  villainSeat: number;
  behind: number;
  cards: CardId[];
}): DecisionView {
  const seatOrder = Array.from({ length: opts.n }, (_, i) => i);
  const order = preflopActionOrder(seatOrder);
  const heroIdx = order.indexOf(opts.heroSeat);
  const pending = [
    opts.heroSeat,
    ...order.slice(heroIdx + 1, heroIdx + 1 + opts.behind),
  ];
  const me = seat({ seat: opts.heroSeat, userId: 1, displayName: 'hero', isMe: true });
  const opponents = seatOrder
    .filter((s) => s !== opts.heroSeat)
    .map((s) => seat({ seat: s, userId: 100 + s, displayName: `v${s}` }));
  return {
    room: { id: 'r', name: 'r', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: {
      handId: 'h',
      street: 'preflop',
      buttonSeat: opts.n === 2 ? 0 : opts.n - 1,
      board: [],
      pot: 1200,
      currentBet: 750,
      toAct: opts.heroSeat,
      deadline: null,
      myCards: opts.cards,
      mySeat: opts.heroSeat,
    },
    me,
    legalActions: null,
    potOdds: null,
    actionHistory: [
      act(opts.heroSeat, 'raise', 250),
      act(opts.villainSeat, 'raise', 750),
    ],
    opponents,
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder,
    actionSeq: 0,
    needToActSeats: pending,
  };
}

function withCards(view: DecisionView, key: string): DecisionView {
  return { ...view, hand: { ...view.hand!, myCards: cardsFor(key) } };
}

function freqs(view: DecisionView, params: RuleParams, key: string) {
  return choosePreflopIntent(withCards(view, key), params, () => 0).frequencies;
}

const adaptive = (kind: keyof typeof RULE_PRESETS): RuleParams => ({
  ...RULE_PRESETS[kind],
  adaptivePreflop: true,
});
const legacy = (kind: keyof typeof RULE_PRESETS): RuleParams => ({
  ...RULE_PRESETS[kind],
  adaptivePreflop: false,
});

/** 6-max: UTG (seat 2) opened, BTN (seat 5) 3-bet. Natural max behind = 3. */
const SIX_MAX = (behind: number) =>
  facing3BetView({ n: 6, heroSeat: 2, villainSeat: 5, behind, cards: cardsFor('AA') });

/** 9-max: UTG (seat 2) opened, BTN (seat 8) 3-bet. Behind reaches 8. */
const NINE_MAX = (behind: number) =>
  facing3BetView({ n: 9, heroSeat: 2, villainSeat: 8, behind, cards: cardsFor('AA') });

const LEGAL_RAISE: DecisionLegalActions = {
  canCheck: false,
  canCall: true,
  callAmount: 500,
  canBet: false,
  canRaise: true,
  minRaiseTo: 1500,
  maxRaiseTo: 10_000,
};

describe('preflop facing-3-bet coverage: the 4-bet path is wired', () => {
  it('classifies the constructed view as facing3Bet with the intended behind count', () => {
    const six = derivePreflopContext(SIX_MAX(1));
    expect(six.spot).toBe('facing3Bet');
    expect(six.heroRaised).toBe(true);
    expect(six.behindUnacted).toBe(1);
    expect(adaptivePreflopAvailable(six, adaptive('constrained-random'))).toBe(true);

    const nine = derivePreflopContext(NINE_MAX(8));
    expect(nine.spot).toBe('facing3Bet');
    expect(nine.behindUnacted).toBe(8);
    expect(adaptivePreflopAvailable(nine, adaptive('constrained-random'))).toBe(true);
    expect(adaptivePreflopAvailable(nine, legacy('constrained-random'))).toBe(false);
  });

  it('enumerates all 169 classes and keeps premium 4-bet raise intent alive', () => {
    expect(allHandClasses()).toHaveLength(169);
    const views = {
      '6max-b0': SIX_MAX(0),
      '6max-b3': SIX_MAX(3),
      '9max-b0': NINE_MAX(0),
      '9max-b8': NINE_MAX(8),
    } as const;
    for (const kind of ['constrained-random', 'tight-aggressive'] as const) {
      for (const params of [adaptive(kind), legacy(kind)]) {
        for (const [label, view] of Object.entries(views)) {
          for (const key of ['AA', 'KK', 'AKs', 'AKo']) {
            const f = freqs(view, params, key);
            expect(
              f.raise,
              `${kind} ${label} ${key} raise`,
            ).toBeGreaterThan(0);
          }
          expect(
            freqs(view, params, 'QQ').call,
            `${kind} ${label} QQ call`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('does not zero the value raise between behindUnacted 0 and 8', () => {
    for (const kind of ['constrained-random', 'tight-aggressive'] as const) {
      for (const params of [adaptive(kind), legacy(kind)]) {
        for (const key of ['AA', 'KK', 'AKs', 'AKo']) {
          const b0 = freqs(NINE_MAX(0), params, key).raise;
          const b8 = freqs(NINE_MAX(8), params, key).raise;
          expect(b0, `${kind} ${key} b0`).toBeGreaterThan(0);
          expect(b8, `${kind} ${key} b8`).toBeGreaterThan(0);
          expect(Math.min(b0, b8), `${kind} ${key} min(b0,b8)`).toBeGreaterThan(0);
        }
        // AA/KK are the exempt premiums: fixed at full frequency at any behind.
        for (const key of ['AA', 'KK']) {
          expect(freqs(NINE_MAX(0), params, key).raise).toBeCloseTo(1, 9);
          expect(freqs(NINE_MAX(8), params, key).raise).toBeCloseTo(1, 9);
        }
      }
    }
  });

  it('QQ is a deliberate flat, not an accidental fold (raise+call = 1)', () => {
    const f = freqs(NINE_MAX(0), adaptive('constrained-random'), 'QQ');
    expect(f.raise).toBe(0);
    expect(f.call).toBeCloseTo(1, 9);
  });

  it('the full RulePolicy adapter returns a raise (never legal-rejected) for AA/KK/AKs/AKo at behind 0', () => {
    for (const kind of ['constrained-random', 'tight-aggressive'] as const) {
      const policy = new RulePolicy({ kind, params: adaptive(kind), seed: 0x9e3779b9 });
      for (const key of ['AA', 'KK', 'AKs', 'AKo']) {
        const view: DecisionView = { ...withCards(SIX_MAX(0), key), legalActions: LEGAL_RAISE };
        const decision = policy.decide(view);
        expect(
          decision.action.type,
          `${kind} ${key}`,
        ).toMatch(/^(raise|bet)$/);
      }
    }
  });
});
