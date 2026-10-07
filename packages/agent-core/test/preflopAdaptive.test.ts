import { describe, expect, it, vi } from 'vitest';
import {
  applyAction,
  cardFromName,
  startHand,
  type BettingState,
  type CardId,
  type PlayerAction,
} from '@4am/shared';
import {
  buildDecisionView,
  type DecisionLegalActions,
  type DecisionSeat,
  type DecisionView,
  type PublicAction,
} from '../src/decisionView.js';
import { HeadlessClient } from '../src/client.js';
import { RulePolicy } from '../src/rulePolicy.js';
import { choosePreflopIntent, derivePreflopContext, adaptivePreflopAvailable, preflopMixCacheKey } from '../src/preflopPolicy.js';
import {
  DERIVED_ANCHOR_PREMIUM,
  HAND_KEYS,
  bbDefendChartFor,
  buildChartMix,
  buildDerivedChart,
  chartLimpShare,
  chartToRangeEntries,
  chartWidth,
  computeBehindUnacted,
  continueWidthScale,
  huChart,
  maxReachableWidth,
  multiwayWidthScale,
  preflopActionOrder,
  rangeEntriesToRawSpot,
  rawSpotWidth,
  rescaleRangeMix,
  rfiChartForSlot,
  rustVsOpenRaiseTable,
  slotsForDealtCount,
  taperRawSpot,
  worstCellDeviation,
  type PreflopChart,
} from '../src/preflopCharts/index.js';
import { FRLA_BB_DEFEND, FRLA_RFI, MHL_HU } from '../src/preflopCharts/data/index.js';
import {
  BB_DEFEND,
  CALL_VS_OPEN,
  COLD_3BET_BLUFF,
  COLD_3BET_BLUFF_WEIGHT,
  COLD_3BET_COLD,
  COLD_3BET_VALUE,
  FACING_3BET_4BET,
  FACING_3BET_CALL,
  FACING_4BET_PLUS,
  ISO_RANGES,
  RFI_RANGES,
} from '../src/preflopRanges.js';
import { compileRangeMix, mixFor, parseRange, type RangeEntry } from '../src/rangeParser.js';
import {
  ADAPTIVE_PREFLOP_DEFAULT,
  RULE_PRESETS,
  type RuleParams,
} from '../src/ruleStyles.js';
import type { PolicyKind } from '../src/policyStyles.js';
import * as Baseline from './fixtures/preflopPolicyBaseline.js';
import * as BaselineRule from './fixtures/rulePolicyBaseline.js';

/**
 * Headcount-adaptive preflop charts (step 1).
 *
 * The tests cover the four accepted properties: width monotonic in behind,
 * no mapping holes for 2..9 handed, the normalisation invariants, and the HU
 * anchors — plus the *fallback* guarantee that the legacy tables are untouched
 * when `adaptivePreflop` is off.
 */

const ADAPTIVE: RuleParams = { ...RULE_PRESETS['tight-aggressive'], adaptivePreflop: true };
/**
 * Explicit kill-switch. The adaptive engine is the shipped default
 * (`ADAPTIVE_PREFLOP_DEFAULT === true`), so the legacy route must be requested
 * on purpose rather than assumed from an untouched preset.
 */
const LEGACY: RuleParams = { ...RULE_PRESETS['tight-aggressive'], adaptivePreflop: false };

const c = (n: string) => cardFromName(n);

function allCombos(): CardId[][] {
  const out: CardId[][] = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) out.push([a, b]);
  return out;
}

const COMBOS = allCombos();

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

/**
 * A full n-handed, unopened preflop view in dealing order `[0..n-1]` (seat 0 =
 * SB), with the hero at `heroSeat`.
 */
function nHandedView(
  n: number,
  heroSeat: number,
  cards: CardId[],
  over: Partial<DecisionView> = {},
): DecisionView {
  const seatOrder = Array.from({ length: n }, (_, i) => i);
  const me = seat({ seat: heroSeat, userId: 1, displayName: 'hero', isMe: true });
  const opponents = seatOrder
    .filter((s) => s !== heroSeat)
    .map((s) => seat({ seat: s, userId: 100 + s, displayName: `v${s}` }));
  return {
    room: { id: 'r', name: 'r', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: {
      handId: 'h',
      street: 'preflop',
      buttonSeat: n === 2 ? 0 : n - 1,
      board: [],
      pot: 150,
      currentBet: 100,
      toAct: heroSeat,
      deadline: null,
      myCards: cards,
      mySeat: heroSeat,
    },
    me,
    legalActions: null,
    potOdds: null,
    actionHistory: [],
    opponents,
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder,
    actionSeq: 0,
    ...over,
  };
}

/** Combo-weighted participation the policy actually produces, ignoring the roll. */
function measuredWidth(view: DecisionView, params: RuleParams): number {
  let sum = 0;
  for (const cards of COMBOS) {
    const v: DecisionView = { ...view, hand: { ...view.hand!, myCards: cards } };
    const f = choosePreflopIntent(v, params, () => 0.5).frequencies;
    sum += f.raise + f.call;
  }
  return sum / COMBOS.length;
}

/**
 * Combo-weighted width of the adaptive RFI *core*: the chart's pure (`value`)
 * raises plus its flat-call residual. `tight-aggressive` (`preflopScale === 1`)
 * folds the whole `marginal` edge layer, so its measured RFI width equals this
 * core width exactly.
 */
function adaptiveRfiCoreWidth(chart: PreflopChart): number {
  let combos = 0;
  for (const key of HAND_KEYS) {
    const m = chart.mix[key];
    if (!m) continue;
    const raise = m.raise + m.allin;
    if (raise > 0 && m.raiseRole === 'value') combos += parseRange(key).combos * raise;
    combos += parseRange(key).combos * m.call;
  }
  return combos / COMBOS.length;
}

type Policy = { choosePreflopIntent: typeof choosePreflopIntent };

/** Same as `measuredWidth`, but against a freshly (re)imported policy module. */
function measuredWidthWith(policy: Policy, view: DecisionView, params: RuleParams): number {
  let sum = 0;
  for (const cards of COMBOS) {
    const v: DecisionView = { ...view, hand: { ...view.hand!, myCards: cards } };
    const f = policy.choosePreflopIntent(v, params, () => 0.5).frequencies;
    sum += f.raise + f.call;
  }
  return sum / COMBOS.length;
}

/** One observed preflop action with the fields the policy reads. */
function act(seat: number, type: PlayerAction['type'], amount?: number): PublicAction {
  return { actionSeq: 0, street: 'preflop', seat, action: { type, ...(amount === undefined ? {} : { amount }) }, auto: false, ts: 0 };
}

/** Apply per-seat state overrides (folded / all-in / sitting-out) to a view. */
function withStates(view: DecisionView, states: Record<number, Partial<DecisionSeat>>): DecisionView {
  return {
    ...view,
    me: view.me ? { ...view.me, ...(states[view.me.seat] ?? {}) } : view.me,
    opponents: view.opponents.map((o) => ({ ...o, ...(states[o.seat] ?? {}) })),
  };
}

/** Legacy RFI width for `position` as a fraction of all combos. */
function legacyRfiWidth(position: keyof typeof RFI_RANGES): number {
  return parseRange(RFI_RANGES[position]).combos / COMBOS.length;
}

// ---------------------------------------------------------------------------
// chart construction invariants
// ---------------------------------------------------------------------------

describe('preflopCharts: construction invariants', () => {
  it('normalises all 169 cells to 1 for every slot and HU', () => {
    for (let s = 0; s <= 8; s++) {
      expect(worstCellDeviation(rfiChartForSlot(s)!) * 1326).toBeLessThan(0.01);
      expect(Object.keys(rfiChartForSlot(s)!.mix)).toHaveLength(169);
    }
    expect(worstCellDeviation(huChart()) * 1326).toBeLessThan(0.01);
    expect(Object.keys(huChart().mix)).toHaveLength(169);
  });

  it('converts to RangeEntry[] with raise + call <= 1 per class', () => {
    const charts = [...Array.from({ length: 9 }, (_, s) => rfiChartForSlot(s)!), huChart()];
    for (const chart of charts) {
      expect(worstCellDeviation(chart) * 1326).toBeLessThan(0.01);
      const compiled = compileRangeMix(chartToRangeEntries(chart));
      for (const key of HAND_KEYS) {
        const m = mixFor(compiled, key);
        expect(m.valueRaise + m.bluffRaise + m.marginalRaise + m.call).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('marks value vs bluff raise roles explicitly', () => {
    // Alpha premiums never fold: value.
    const utg = rfiChartForSlot(5)!;
    expect(utg.mix['AA']!.raise + utg.mix['AA']!.allin).toBeCloseTo(1, 9);
    expect(utg.mix['AA']!.raiseRole).toBe('value');
    // Some class must be a raise/fold bluff; its role must be `bluff`.
    const bluff = HAND_KEYS.find((k) => {
      const m = utg.mix[k]!;
      return m.raise + m.allin > 0 && m.fold > 1e-6;
    });
    expect(bluff).toBeDefined();
    expect(utg.mix[bluff!]!.raiseRole).toBe('bluff');
  });

  it('keeps p=1 strong hands at 1 under narrowing and widening', () => {
    const utg = FRLA_RFI.spots['UTG-RFI']!;
    const narrow = buildChartMix(utg, 0.05);
    expect(narrow['AA']!.raise + narrow['AA']!.allin + narrow['AA']!.call).toBeCloseTo(1, 9);
    // A reachable widen target (between the anchor width and the ceiling).
    const widenTarget = (rawSpotWidth(utg) + maxReachableWidth(utg)) / 2;
    const widen = buildChartMix(utg, widenTarget);
    expect(widen['AA']!.raise + widen['AA']!.allin + widen['AA']!.call).toBeCloseTo(1, 9);
  });

  it('caps widening at maxReachableWidth and throws above the ceiling', () => {
    const utg = FRLA_RFI.spots['UTG-RFI']!;
    const ceiling = maxReachableWidth(utg);
    expect(ceiling).toBeGreaterThan(rawSpotWidth(utg));
    // The ceiling is exactly the combo share of the anchor's participating hands.
    const participating = HAND_KEYS.filter((k) => utg[k] && utg[k]![0] + utg[k]![1] + utg[k]![2] > 0);
    expect(ceiling).toBeCloseTo(participating.reduce((s, k) => s + (parseRange(k).combos), 0) / COMBOS.length, 12);
    // Above the ceiling: explicit error, not a silently wrong width.
    expect(() => buildChartMix(utg, ceiling + 0.01)).toThrow(/reachable ceiling/);
    // At the ceiling widening still works.
    expect(() => buildChartMix(utg, ceiling)).not.toThrow();
  });

  it('keeps p=0 hands folded when widening (the p>0 guard)', () => {
    const spot = { AA: [1, 0, 0], KK: [0.5, 0, 0], '32o': [0, 0, 0] } as const;
    const ceiling = maxReachableWidth(spot);
    // `32o` is explicitly present but never played: it must not enlarge the cap.
    expect(ceiling).toBeCloseTo((6 + 6) / COMBOS.length, 12);
    const mix = buildChartMix(spot, ceiling);
    expect(mix['32o']!.raise + mix['32o']!.allin + mix['32o']!.call).toBe(0);
    expect(mix['32o']!.fold).toBeCloseTo(1, 9);
    // KK is rescuable to full frequency; AA was already full.
    expect(mix['KK']!.raise + mix['KK']!.allin + mix['KK']!.call).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------
// width monotonicity + 6-max/FRLA agreement
// ---------------------------------------------------------------------------

describe('preflopCharts: width monotonicity', () => {
  it('B1 >= B2 >= ... >= B8 (tolerance 0.5pt)', () => {
    const widths = Array.from({ length: 8 }, (_, i) => chartWidth(rfiChartForSlot(i + 1)!));
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThanOrEqual(widths[i - 1]! + 0.005);
    }
  });

  it('matches each FRLA 6-max anchor within 2pt', () => {
    const anchors: Record<number, string> = {
      1: 'SB-RFI',
      2: 'BTN-RFI',
      3: 'CO-RFI',
      4: 'MP-RFI',
      5: 'UTG-RFI',
    };
    for (const [slot, spot] of Object.entries(anchors)) {
      const want = rawSpotWidth(FRLA_RFI.spots[spot]!);
      const got = chartWidth(rfiChartForSlot(Number(slot))!);
      expect(Math.abs(got - want)).toBeLessThan(0.02);
    }
  });

  it('extrapolates the 9-max tail to the published widths', () => {
    expect(chartWidth(rfiChartForSlot(6)!)).toBeCloseTo(0.1574, 3);
    expect(chartWidth(rfiChartForSlot(7)!)).toBeCloseTo(0.1412, 3);
    expect(chartWidth(rfiChartForSlot(8)!)).toBeCloseTo(0.1266, 3);
  });
});

// ---------------------------------------------------------------------------
// coverage: 2..9 handed has no mapping hole
// ---------------------------------------------------------------------------

describe('headcount: 2..9 handed coverage', () => {
  it('slotsForDealtCount returns n distinct slots including B0 and B1', () => {
    for (let n = 2; n <= 9; n++) {
      const slots = slotsForDealtCount(n);
      expect(slots).toHaveLength(n);
      expect(new Set(slots).size).toBe(n);
      expect(slots).toContain(0);
      expect(slots).toContain(1);
      for (let s = 0; s < n; s++) expect(slots).toContain(s);
    }
  });

  it('a full n-handed, unacted table sees exactly {B0..B(n-1)}', () => {
    for (let n = 2; n <= 9; n++) {
      const order = preflopActionOrder(Array.from({ length: n }, (_, i) => i));
      const active = new Set(order);
      const seen = new Set<number>();
      for (const hero of order) {
        seen.add(
          computeBehindUnacted({ order, heroSeat: hero, activeSeats: active, actedSeats: new Set() }),
        );
      }
      expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it('end-to-end policy widths are monotonic by behindUnacted (9-handed)', () => {
    const order = preflopActionOrder(Array.from({ length: 9 }, (_, i) => i));
    // Exclude the BB (slot B0): it never opens first in, so its width is 0.
    const widths = order
      .slice(0, order.length - 1)
      .map((hero) => measuredWidth(nHandedView(9, hero, [c('Ac'), c('Kd')]), ADAPTIVE));
    for (let i = 1; i < widths.length; i++) {
      // behindUnacted falls as we move through the action order, so the width
      // must rise (B8 is the tightest, B1 the widest).
      expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]! - 0.005);
    }
  });
});

// ---------------------------------------------------------------------------
// heads-up anchors
// ---------------------------------------------------------------------------

describe('preflopCharts: heads-up', () => {
  it('has 87% participation with a 25-40% limp share', () => {
    const hu = huChart();
    const width = chartWidth(hu);
    expect(width).toBeGreaterThanOrEqual(0.8);
    expect(width).toBeLessThanOrEqual(0.9);
    expect(chartLimpShare(hu)).toBeGreaterThanOrEqual(0.25);
    expect(chartLimpShare(hu)).toBeLessThanOrEqual(0.4);
  });

  it('the HU SB view routes to the HU chart, not the 6-max SB chart', () => {
    const view = nHandedView(2, 0, [c('Ac'), c('Kd')]);
    const ctx = derivePreflopContext(view);
    expect(ctx.headsUp).toBe(true);
    expect(ctx.actorSlot).toBe(1);
    const width = measuredWidth(view, ADAPTIVE);
    expect(Math.abs(width - chartWidth(huChart()))).toBeLessThan(1e-9);
    expect(Math.abs(width - chartWidth(rfiChartForSlot(1)!))).toBeGreaterThan(0.01);
  });

  it('maps HU limp frequencies to call', () => {
    expect(MHL_HU.spots['SB_OPEN']).toBeDefined();
    const hu = huChart();
    expect(hu.spot.actorSlot).toBe(1);
    expect(hu.game.seats).toBe(2);
    expect(chartLimpShare(hu)).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// fallback: legacy tables unchanged when the flag is off
// ---------------------------------------------------------------------------

describe('adaptive preflop fallback', () => {
  it('is unavailable without the flag, incomplete history, or a reliable headcount', () => {
    const v = nHandedView(9, 2, [c('Ac'), c('Kd')]);
    const ctx = derivePreflopContext(v);
    expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(true);
    expect(adaptivePreflopAvailable(ctx, LEGACY)).toBe(false);
    const partial = derivePreflopContext({ ...v, historyComplete: false });
    expect(adaptivePreflopAvailable(partial, ADAPTIVE)).toBe(false);
    const noOrder = derivePreflopContext({ ...v, seatOrder: [] });
    expect(noOrder.headcountReliable).toBe(false);
    expect(adaptivePreflopAvailable(noOrder, ADAPTIVE)).toBe(false);
  });

  it('with the flag off the 9-max UTG width is the legacy RFI width', () => {
    const view = nHandedView(9, 2, [c('Ac'), c('Kd')]);
    const legacyWidth = measuredWidth(view, LEGACY);
    const expected = parseRange(RFI_RANGES.UTG).combos / COMBOS.length;
    expect(Math.abs(legacyWidth - expected)).toBeLessThan(1e-9);
    // ...and the adaptive width is genuinely different.
    expect(Math.abs(measuredWidth(view, ADAPTIVE) - legacyWidth)).toBeGreaterThan(0.01);
  });

  it('still routes <20BB to SHORT_JAM_RANGES even with the flag on', () => {
    // 22 opens from the BTN at 100BB but is not in the LP short-jam set.
    const view = nHandedView(6, 5, [c('2c'), c('2d')]);
    const short = { ...view, me: { ...view.me!, stack: 1_500 }, opponents: view.opponents.map((o) => ({ ...o, stack: 1_500 })) };
    expect(derivePreflopContext(short).stackBB).toBeCloseTo(15, 9);
    expect(choosePreflopIntent(short, ADAPTIVE, () => 0.99).intent).toBe('fold');
    const premium = nHandedView(6, 5, [c('Ac'), c('Ad')]);
    const shortAA = { ...premium, me: { ...premium.me!, stack: 1_500 }, opponents: premium.opponents.map((o) => ({ ...o, stack: 1_500 })) };
    expect(choosePreflopIntent(shortAA, ADAPTIVE, () => 0.99).intent).toBe('raise');
  });

  it('never discounts a value raise into a fold', () => {
    const view = nHandedView(9, 2, [c('Ac'), c('Ad')]);
    const discounted: RuleParams = { ...ADAPTIVE, preflopScale: 0.5 };
    const choice = choosePreflopIntent(view, discounted, () => 0.999);
    expect(choice.frequencies.raise + choice.frequencies.call).toBeCloseTo(1, 9);
    expect(choice.intent).not.toBe('fold');
  });
});

// ---------------------------------------------------------------------------
// headcount behaviour: seats, act/behind, blinds, malformed seatOrder
// ---------------------------------------------------------------------------

describe('adaptive preflop headcount behaviour', () => {
  it('maps 2/3/6/9-handed hero first / middle / blind to the right slot', () => {
    const cases: Array<{ n: number; hero: number; behind: number; slot: number; available: boolean }> = [
      { n: 2, hero: 0, behind: 1, slot: 1, available: true }, // HU SB = BTN, first in
      { n: 2, hero: 1, behind: 0, slot: 0, available: false }, // HU BB, nobody to open
      { n: 3, hero: 2, behind: 2, slot: 2, available: true }, // 3-handed first-in (BTN)
      { n: 3, hero: 0, behind: 1, slot: 1, available: true }, // 3-handed SB
      { n: 3, hero: 1, behind: 0, slot: 0, available: false }, // 3-handed BB
      { n: 6, hero: 2, behind: 5, slot: 5, available: true }, // 6-max first-in
      { n: 6, hero: 4, behind: 3, slot: 3, available: true }, // 6-max middle (CO)
      { n: 6, hero: 5, behind: 2, slot: 2, available: true }, // 6-max BTN
      { n: 6, hero: 1, behind: 0, slot: 0, available: false }, // 6-max BB
      { n: 9, hero: 2, behind: 8, slot: 8, available: true }, // 9-max first-in (LJ)
      { n: 9, hero: 6, behind: 4, slot: 4, available: true }, // 9-max middle (HJ)
      { n: 9, hero: 8, behind: 2, slot: 2, available: true }, // 9-max BTN (SB+BB behind)
      { n: 9, hero: 1, behind: 0, slot: 0, available: false }, // 9-max BB
    ];
    for (const { n, hero, behind, slot, available } of cases) {
      const ctx = derivePreflopContext(nHandedView(n, hero, [c('Ac'), c('Kd')]));
      expect({ n, hero, behind: ctx.behindUnacted, slot: ctx.actorSlot }).toEqual({ n, hero, behind, slot });
      expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(available);
    }
  });

  it('excludes folded / all-in / sitting-out seats behind the hero', () => {
    // 6-handed, hero is the first actor; seats 3/4/5 behind fall away.
    const base = nHandedView(6, 2, [c('Ac'), c('Kd')]);
    expect(derivePreflopContext(base).behindUnacted).toBe(5);
    const folded = withStates(base, { 3: { folded: true } });
    expect(derivePreflopContext(folded).behindUnacted).toBe(4);
    const allIn = withStates(base, { 3: { folded: true }, 4: { allIn: true } });
    expect(derivePreflopContext(allIn).behindUnacted).toBe(3);
    const sittingOut = withStates(base, { 3: { folded: true }, 4: { allIn: true }, 5: { sittingOut: true } });
    expect(derivePreflopContext(sittingOut).behindUnacted).toBe(2);
    // ...and folded/all-in seats behind a hero mid-order shift the slot too.
    const mid = nHandedView(6, 4, [c('Ac'), c('Kd')]);
    expect(derivePreflopContext(mid).behindUnacted).toBe(3);
    expect(derivePreflopContext(withStates(mid, { 5: { allIn: true } })).behindUnacted).toBe(2);
  });

  it('uses actionHistory to drop seats that have already acted', () => {
    const base = nHandedView(6, 2, [c('Ac'), c('Kd')]);
    // hero (seat 2) first in, behind = {3,4,5,0,1}.
    const oneActed = { ...base, actionHistory: [act(3, 'call')] };
    expect(derivePreflopContext(oneActed).behindUnacted).toBe(4);
    const threeActed = { ...base, actionHistory: [act(3, 'call'), act(4, 'call'), act(5, 'fold')] };
    expect(derivePreflopContext(threeActed).behindUnacted).toBe(2); // blinds 0,1 still to act
    // A seat that acted *and* then folded is still removed exactly once.
    const actedAndFolded = withStates(oneActed, { 3: { folded: true } });
    expect(derivePreflopContext(actedAndFolded).behindUnacted).toBe(4);
    // The opener slot is measured from the raiser's own behind-unacted count.
    const facing = nHandedView(6, 5, [c('Ac'), c('Kd')]);
    facing.actionHistory = [act(2, 'raise', 250)];
    const fctx = derivePreflopContext(facing);
    expect(fctx.spot).toBe('facingOpen');
    expect(fctx.openerSlot).toBe(5);
    expect(fctx.behindUnacted).toBe(2); // SB + BB still to act behind the BTN
    expect(adaptivePreflopAvailable(fctx, ADAPTIVE)).toBe(false);
  });

  it('routes HU SB first-in to the HU chart but never HU BB', () => {
    // SB (seat 0 = button) first in, no action: the HU RFI chart.
    const sb = nHandedView(2, 0, [c('Ac'), c('Kd')]);
    expect(derivePreflopContext(sb).headcountReliable).toBe(true);
    expect(adaptivePreflopAvailable(derivePreflopContext(sb), ADAPTIVE)).toBe(true);
    expect(measuredWidth(sb, ADAPTIVE)).toBeCloseTo(chartWidth(huChart()), 9);

    // BB (seat 1) unopened: slot B0, never an RFI -> legacy (empty BB RFI -> fold).
    const bb = nHandedView(2, 1, [c('Ac'), c('Kd')]);
    const bbCtx = derivePreflopContext(bb);
    expect(bbCtx.actorSlot).toBe(0);
    expect(adaptivePreflopAvailable(bbCtx, ADAPTIVE)).toBe(false);
    expect(measuredWidth(bb, ADAPTIVE)).toBeCloseTo(legacyRfiWidth('BB'), 9);
  });

  it('keeps HU BB facing a SB raise / limp on the legacy defence, not HU RFI', () => {
    const base = nHandedView(2, 1, [c('Ac'), c('Kd')]);
    const vsRaise = { ...base, actionHistory: [act(0, 'raise', 250)] };
    const vsLimp = { ...base, actionHistory: [act(0, 'call')] };
    const vsFold = { ...base, actionHistory: [act(0, 'fold')] };

    const raiseCtx = derivePreflopContext(vsRaise);
    expect(raiseCtx.spot).toBe('facingOpen');
    expect(adaptivePreflopAvailable(raiseCtx, ADAPTIVE)).toBe(false);
    // Legacy BB defence, definitively not the 87% HU RFI chart.
    expect(measuredWidth(vsRaise, ADAPTIVE)).toBeLessThan(chartWidth(huChart()) - 0.1);
    // The flag alone must not change this route: flag on == flag off.
    expect(measuredWidth(vsRaise, ADAPTIVE)).toBeCloseTo(measuredWidth(vsRaise, LEGACY), 12);

    const limpCtx = derivePreflopContext(vsLimp);
    expect(limpCtx.spot).toBe('limped');
    expect(adaptivePreflopAvailable(limpCtx, ADAPTIVE)).toBe(false);
    expect(measuredWidth(vsLimp, ADAPTIVE)).toBeCloseTo(measuredWidth(vsLimp, LEGACY), 12);

    // SB folds: the view is *unopened* for the BB, but slot B0 blocks the chart.
    const foldCtx = derivePreflopContext(vsFold);
    expect(foldCtx.spot).toBe('unopened');
    expect(adaptivePreflopAvailable(foldCtx, ADAPTIVE)).toBe(false);
    expect(measuredWidth(vsFold, ADAPTIVE)).toBeCloseTo(measuredWidth(vsFold, LEGACY), 12);
  });

  it('rejects duplicate and non-covering seatOrder, accepts reordered', () => {
    const three = nHandedView(3, 2, [c('Ac'), c('Kd')]);
    expect(derivePreflopContext(three).headcountReliable).toBe(true);

    // Duplicate seat: 3 entries but only 2 distinct -> untrustworthy.
    const dup = derivePreflopContext({ ...three, seatOrder: [0, 0, 1] });
    expect(dup.headcountReliable).toBe(false);
    expect(adaptivePreflopAvailable(dup, ADAPTIVE)).toBe(false);

    // Missing a known seat: [0,1] while {0,1,2} is seated. The old subset check
    // read this as a trustworthy 2-handed table; it must now fall back.
    const shortOrder = derivePreflopContext({ ...three, seatOrder: [0, 1] });
    expect(shortOrder.headcountReliable).toBe(false);
    expect(adaptivePreflopAvailable(shortOrder, ADAPTIVE)).toBe(false);

    // Extra seat not known -> untrustworthy.
    const extra = derivePreflopContext({ ...three, seatOrder: [0, 1, 2, 3] });
    expect(extra.headcountReliable).toBe(false);

    // A reordering (dealing order rotated) is fine: order, not sort, matters.
    expect(derivePreflopContext({ ...three, seatOrder: [1, 2, 0] }).headcountReliable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cache key
// ---------------------------------------------------------------------------

describe('adaptive preflop cache key', () => {
  it('distinguishes dealtCount / slot / auction / route', () => {
    const six = derivePreflopContext(nHandedView(6, 2, [c('Ac'), c('Kd')]));
    const nine = derivePreflopContext(nHandedView(9, 2, [c('Ac'), c('Kd')]));
    expect(preflopMixCacheKey(six, ADAPTIVE)).not.toBe(preflopMixCacheKey(nine, ADAPTIVE));
    expect(preflopMixCacheKey(six, ADAPTIVE)).not.toBe(preflopMixCacheKey(six, LEGACY));
  });

  it('keys the final route, not the flag, so adaptive and fallback never collide', async () => {
    // Same position / dealtCount / slot; only historyComplete differs, which
    // flips the final route adaptive -> legacy despite the flag staying on.
    const adaptiveView = nHandedView(9, 2, [c('Ac'), c('Kd')]); // historyComplete: true
    const legacyView: DecisionView = { ...adaptiveView, historyComplete: false };
    const adaptiveCtx = derivePreflopContext(adaptiveView);
    const legacyCtx = derivePreflopContext(legacyView);

    expect(adaptivePreflopAvailable(adaptiveCtx, ADAPTIVE)).toBe(true);
    expect(adaptivePreflopAvailable(legacyCtx, ADAPTIVE)).toBe(false);
    expect(adaptiveCtx.actorSlot).toBe(legacyCtx.actorSlot);
    expect(adaptiveCtx.position).toBe(legacyCtx.position);
    expect(preflopMixCacheKey(adaptiveCtx, ADAPTIVE)).not.toBe(preflopMixCacheKey(legacyCtx, ADAPTIVE));

    // `tight-aggressive` (preflopScale 1) folds the adaptive `marginal` edge
    // layer, so its adaptive RFI width is exactly the chart's pure-value core.
    const adaptiveWidth = adaptiveRfiCoreWidth(rfiChartForSlot(8)!);
    const legacyWidth = legacyRfiWidth('UTG');
    expect(Math.abs(adaptiveWidth - legacyWidth)).toBeGreaterThan(0.01);

    // Both call orders, each against a fresh module (so `mixCache` is empty and
    // the *first* call in the pair is what a collision would poison).
    for (const order of ['adaptive-first', 'legacy-first'] as const) {
      vi.resetModules();
      const policy: Policy = await import('../src/preflopPolicy.js');
      // Property evaluation order is the point: whichever view is measured first
      // is what an (incorrectly shared) cache entry would poison for the second.
      const got =
        order === 'adaptive-first'
          ? {
              adaptive: measuredWidthWith(policy, adaptiveView, ADAPTIVE),
              legacy: measuredWidthWith(policy, legacyView, ADAPTIVE),
            }
          : {
              legacy: measuredWidthWith(policy, legacyView, ADAPTIVE),
              adaptive: measuredWidthWith(policy, adaptiveView, ADAPTIVE),
            };
      expect(got.adaptive).toBeCloseTo(adaptiveWidth, 9);
      expect(got.legacy).toBeCloseTo(legacyWidth, 9);
    }
  });

  it('isolates the opener name, so build order cannot poison BB / vs-3bet / vs-4bet mixes', async () => {
    // 9-max: MP (behind 6) and LJ (behind 5) share `openerGroup === 'MP'` and
    // the sixMax slot 4, but only LJ maps onto a Rust seat (UTG). Before the
    // cache key carried `ctx.opener`, a `facingOpen` mix built for one poisoned
    // the other's cached entry, so the result depended on which was asked first
    // — and the same key shape is used by the BB / vs-3bet / vs-4bet routes.
    const cards = [c('Ac'), c('Kd')];
    const coVsMp = faceOpenView(9, 7, 4, cards); // CO hero, MP opener -> unmapped
    const coVsLj = faceOpenView(9, 7, 5, cards); // CO hero, LJ opener -> Rust UTG
    const mpCtx = derivePreflopContext(coVsMp);
    const ljCtx = derivePreflopContext(coVsLj);
    expect(mpCtx.openerGroup).toBe('MP');
    expect(ljCtx.openerGroup).toBe('MP');
    expect(mpCtx.openerSlot).toBe(4);
    expect(ljCtx.openerSlot).toBe(4);
    expect(mpCtx.opener).not.toBe(ljCtx.opener);
    // Only the opener *name* separates the two keys.
    expect(preflopMixCacheKey(mpCtx, ADAPTIVE)).not.toBe(preflopMixCacheKey(ljCtx, ADAPTIVE));

    // The rest of the auction routes that also carry an opener: BB defence
    // against each opener, and a hero who opened and now faces a 3-bet / 4-bet.
    const views: Record<string, DecisionView> = {
      coVsMp,
      coVsLj,
      bbVsMp: faceOpenView(9, 1, 4, cards),
      bbVsLj: faceOpenView(9, 1, 5, cards),
      vs3bet: auctionView({
        n: 9,
        heroSeat: 4,
        history: [act(4, 'raise', 250), act(8, 'raise', 750)],
        pending: [4],
        currentBet: 750,
      }),
      vs4bet: auctionView({
        n: 9,
        heroSeat: 4,
        history: [act(4, 'raise', 250), act(8, 'raise', 750), act(0, 'raise', 2000)],
        pending: [4],
        currentBet: 2000,
      }),
    };
    const names = Object.keys(views);

    async function run(order: readonly string[]): Promise<Record<string, number>> {
      vi.resetModules();
      const policy: Policy = await import('../src/preflopPolicy.js');
      const out: Record<string, number> = {};
      for (const name of order) out[name] = measuredWidthWith(policy, views[name]!, ADAPTIVE);
      return out;
    }

    // Forward: legacy (early opener) first, then the Rust-mapped opener.
    const forward = await run(names);
    // Reverse build order must reproduce every mix.
    const reverse = await run([...names].reverse());
    for (const name of names) {
      expect(reverse[name], `${name} depends on build order`).toBeCloseTo(forward[name]!, 12);
    }
    // Each mix also matches a fresh, single-context build.
    for (const name of names) {
      const solo = await run([name]);
      expect(solo[name], `${name} poisoned by an earlier context`).toBeCloseTo(forward[name]!, 12);
    }
    // Guard against a vacuous pass: the mapped and unmapped opener really do
    // resolve to different mixes (Rust active only for LJ).
    expect(Math.abs(forward['coVsLj']! - forward['coVsMp']!)).toBeGreaterThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// step 2: facing an open — current-round acted semantics + defensive charts
// ---------------------------------------------------------------------------

/** Width of a compiled legacy range, as a fraction of all combos. */
function legacyRangeWidth(entries: RangeEntry[]): number {
  const mix = compileRangeMix(entries);
  let sum = 0;
  for (const [key, m] of mix) {
    sum += parseRange(key).combos * Math.min(1, m.valueRaise + m.bluffRaise + m.marginalRaise + m.call);
  }
  return sum / COMBOS.length;
}

/** Total unweighted frequency in a compiled mix (value + bluff + call). */
function sumMix(mix: Map<string, { valueRaise: number; bluffRaise: number; marginalRaise: number; call: number }>): number {
  let sum = 0;
  for (const [, m] of mix) sum += m.valueRaise + m.bluffRaise + m.marginalRaise + m.call;
  return sum;
}

/** The legacy cold 3-bet / cold-call anchor for an opener x hero group pair. */
function coldEntries(
  openerGroup: keyof typeof COLD_3BET_VALUE,
  heroGroup: keyof typeof CALL_VS_OPEN,
): RangeEntry[] {
  return [
    { range: COLD_3BET_VALUE[openerGroup], action: 'raise', weight: 1, role: 'value' },
    { range: COLD_3BET_BLUFF[openerGroup], action: 'raise', weight: COLD_3BET_BLUFF_WEIGHT, role: 'bluff' },
    { range: CALL_VS_OPEN[heroGroup], action: 'call', weight: 1 },
  ];
}

/**
 * A single-open view: `openerSeat` raised, the hero is to decide, and the
 * server's current-round `needToAct` lists the hero plus everyone behind them.
 */
function faceOpenView(
  n: number,
  heroSeat: number,
  openerSeat: number,
  cards: CardId[],
  over: Partial<DecisionView> = {},
): DecisionView {
  const base = nHandedView(n, heroSeat, cards, over);
  const order = preflopActionOrder(Array.from({ length: n }, (_, i) => i));
  const idx = order.indexOf(heroSeat);
  return {
    ...base,
    hand: { ...base.hand!, currentBet: 250, toAct: heroSeat },
    actionHistory: [act(openerSeat, 'raise', 250)],
    needToActSeats: [...order.slice(idx)],
  };
}

describe('step 2: faced-open acted semantics', () => {
  it('re-includes the earlier callers once a raise reopens the round', () => {
    // 6-max: UTG opens, HJ and CO call, BTN 3-bets. The raise reopens the
    // round, so UTG owes action again and HJ/CO are behind him *again* — the
    // flat "acted at some point" set would count only the two blinds.
    const base = nHandedView(6, 2, [c('Ac'), c('Kd')]);
    const reopens: DecisionView = {
      ...base,
      actionHistory: [act(2, 'raise', 250), act(3, 'call'), act(4, 'call'), act(5, 'raise', 750)],
      // Server rebuilds `needToAct` from the raiser: SB, BB, then UTG (who
      // raised), HJ and CO (the reopened callers).
      needToActSeats: [0, 1, 2, 3, 4],
    };
    const tracked = derivePreflopContext(reopens);
    expect(tracked.needToActTracked).toBe(true);
    expect(tracked.behindUnacted).toBe(4); // HJ, CO, SB, BB all still owe

    const untracked = derivePreflopContext({ ...reopens, needToActSeats: undefined });
    expect(untracked.needToActTracked).toBe(false);
    expect(untracked.behindUnacted).toBe(2); // legacy inference: only the blinds
    expect(tracked.behindUnacted).toBeGreaterThan(untracked.behindUnacted);
  });

  it('refuses the facing-open charts when the server did not supply needToAct', () => {
    const view = faceOpenView(6, 1, 2, [c('Ac'), c('Kd')]);
    expect(adaptivePreflopAvailable(derivePreflopContext(view), ADAPTIVE)).toBe(true);

    const untracked: DecisionView = { ...view, needToActSeats: undefined };
    const ctx = derivePreflopContext(untracked);
    expect(ctx.needToActTracked).toBe(false);
    expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(false);
    expect(measuredWidth(untracked, ADAPTIVE)).toBeCloseTo(measuredWidth(untracked, LEGACY), 12);
  });
});

describe('step 2: BB defence by opener slot', () => {
  // 6-max dealing order: 0 SB, 1 BB, 2 UTG, 3 HJ, 4 CO, 5 BTN.
  const cases = [
    { seat: 2, slot: 5, key: 'BB-vs-open-UTG' },
    { seat: 3, slot: 4, key: 'BB-vs-open-MP' },
    { seat: 4, slot: 3, key: 'BB-vs-open-CO' },
    { seat: 5, slot: 2, key: 'BB-vs-open-BTN' },
    { seat: 0, slot: 1, key: 'BB-vs-open-SB' },
  ] as const;

  it('charts are 169-cell normalised', () => {
    for (const { slot } of cases) {
      const chart = bbDefendChartFor(slot);
      expect(Object.keys(chart.mix)).toHaveLength(169);
      expect(worstCellDeviation(chart) * 1326).toBeLessThan(0.01);
    }
  });

  it('narrows monotonically the earlier the opener (UTG tightest, SB widest)', () => {
    const widths = cases.map(({ slot }) => chartWidth(bbDefendChartFor(slot)));
    // cases run slot 5 (UTG) -> 1 (SB); the later the opener, the wider.
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
  });

  it('end-to-end BB views match the anchor selected by openerSlot', () => {
    for (const { seat, slot, key } of cases) {
      const view = faceOpenView(6, 1, seat, [c('Ac'), c('Kd')]);
      const ctx = derivePreflopContext(view);
      expect(ctx.openerSlot).toBe(slot);
      expect(ctx.spot).toBe('facingOpen');
      expect(ctx.actorSlot).toBe(0);
      expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(true);
      const anchor = rawSpotWidth(FRLA_BB_DEFEND.spots[key]!);
      expect(Math.abs(measuredWidth(view, ADAPTIVE) - anchor)).toBeLessThan(0.005);
    }
  });

  it('keeps the huge-9max openers on the matching 6-max anchor', () => {
    // 9-max: UTG(2), MP(4), CO(7), BTN(8) must map to UTG/MP/CO/BTN anchors,
    // not to their raw behind-unacted slot (BTN is B0 there).
    const mapping: Array<[number, number]> = [
      [2, 5],
      [4, 4],
      [7, 3],
      [8, 2],
    ];
    for (const [seat, slot] of mapping) {
      const ctx = derivePreflopContext(faceOpenView(9, 1, seat, [c('Ac'), c('Kd')]));
      expect(ctx.openerSlot).toBe(slot);
    }
  });

  it('does not collide cache entries across opener slots', () => {
    const utg = derivePreflopContext(faceOpenView(6, 1, 2, [c('Ac'), c('Kd')]));
    const btn = derivePreflopContext(faceOpenView(6, 1, 5, [c('Ac'), c('Kd')]));
    expect(utg.openerSlot).not.toBe(btn.openerSlot);
    expect(preflopMixCacheKey(utg, ADAPTIVE)).not.toBe(preflopMixCacheKey(btn, ADAPTIVE));
  });
});

describe('step 2: non-BB cold continue', () => {
  it('tightens monotonically as more players remain to act', () => {
    const widths = [3, 4, 5].map((hero) =>
      measuredWidth(faceOpenView(6, hero, 2, [c('Ac'), c('Kd')]), ADAPTIVE),
    );
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
  });

  it('keeps raise + call frequency <= 1 for every hand class', () => {
    // The raw anchor can overlap (a hand may be both a 3-bet and a flat call);
    // the guarantee is the *effective* policy frequency, which budgets the
    // overlap. Check it end-to-end for every hand class.
    const view = faceOpenView(6, 3, 2, [c('Ac'), c('Kd')]);
    for (const cards of COMBOS) {
      const f = choosePreflopIntent(
        { ...view, hand: { ...view.hand!, myCards: cards } },
        ADAPTIVE,
        () => 0.5,
      ).frequencies;
      expect(f.raise + f.call).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('tightens the cold range while leaving 3-bet value raises intact', () => {
    const entries = coldEntries('EP', 'LP');
    const wide = rescaleRangeMix(entries, 1);
    const tight = rescaleRangeMix(entries, continueWidthScale(4));
    expect(sumMix(tight)).toBeLessThan(sumMix(wide));
    // A pure value 3-bet (AA) must never fold, however tight the spot.
    expect(wide.get('AA')!.valueRaise).toBe(1);
    expect(tight.get('AA')!.valueRaise).toBe(1);
    expect(legacyRangeWidth(entries)).toBeGreaterThan(0);
  });
});

describe('step 2: fallback', () => {
  it('flag off keeps the legacy BB defence', () => {
    const view = faceOpenView(6, 1, 2, [c('Ac'), c('Kd')]);
    expect(adaptivePreflopAvailable(derivePreflopContext(view), LEGACY)).toBe(false);
    expect(measuredWidth(view, LEGACY)).toBeCloseTo(legacyRangeWidth(BB_DEFEND.EP), 3);
    // The adaptive route is genuinely different (it uses the solver subset).
    expect(Math.abs(measuredWidth(view, ADAPTIVE) - measuredWidth(view, LEGACY))).toBeGreaterThan(0.005);
  });

  it('flag off keeps the legacy cold continue', () => {
    const view = faceOpenView(6, 5, 2, [c('Ac'), c('Kd')]); // BTN vs UTG open
    expect(adaptivePreflopAvailable(derivePreflopContext(view), LEGACY)).toBe(false);
    expect(measuredWidth(view, LEGACY)).toBeCloseTo(legacyRangeWidth(coldEntries('EP', 'LP')), 3);
    // ...while the adaptive route narrows it by the behind-unacted count.
    expect(measuredWidth(view, ADAPTIVE)).toBeLessThan(measuredWidth(view, LEGACY));
  });
});

// ---------------------------------------------------------------------------
// facing-open frequency budget: raise + call <= 1 on every preset
// ---------------------------------------------------------------------------

describe('facing-open frequency budget: raise + call <= 1 for every preset', () => {
  /**
   * Every `facingOpen` spot that carries both a 3-bet raise and a flat call:
   * all ten Rust vs-open mappings (6-max hero/opener behind-count pairs) plus
   * the BB defence open. These are the spots where `raiseScale > 1` (LAG's
   * `threeBetScale`) can outgrow the continuation budget.
   */
  const spots: Array<[name: string, heroSeat: number, openerSeat: number]> = [
    ['HJ-vs-UTG', 3, 2],
    ['CO-vs-UTG', 4, 2],
    ['BTN-vs-UTG', 5, 2],
    ['SB-vs-UTG', 0, 2],
    ['CO-vs-HJ', 4, 3],
    ['BTN-vs-HJ', 5, 3],
    ['SB-vs-HJ', 0, 3],
    ['BTN-vs-CO', 5, 4],
    ['SB-vs-CO', 0, 4],
    ['SB-vs-BTN', 0, 5],
    ['BB-vs-UTG', 1, 2],
  ];

  it('keeps raise + call <= 1 for every preset across every facing-open spot', () => {
    for (const [name, hero, opener] of spots) {
      const view = faceOpenView(6, hero, opener, [c('Ac'), c('Kd')]);
      for (const kind of Object.keys(RULE_PRESETS) as PolicyKind[]) {
        const params: RuleParams = { ...RULE_PRESETS[kind], adaptivePreflop: true };
        for (const cards of COMBOS) {
          const f = choosePreflopIntent(
            { ...view, hand: { ...view.hand!, myCards: cards } },
            params,
            () => 0.5,
          ).frequencies;
          expect(f.raise + f.call, `${kind} ${name}`).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
  });

  it('exercises the amplification path (LAG 3-bet scale > 1 and raises wider)', () => {
    // Non-vacuity: `loose-aggressive` is the only preset whose `threeBetScale`
    // exceeds 1, so it is the one that drives the scaled value raise past the
    // raw continuation anchor. Pin that it really amplifies, so the budget guard
    // above is measured on a preset that takes the >1 branch.
    expect(RULE_PRESETS['loose-aggressive'].threeBetScale).toBeGreaterThan(1);
    const view = faceOpenView(6, 5, 2, [c('Ac'), c('Kd')]); // BTN vs UTG
    const lag: RuleParams = { ...RULE_PRESETS['loose-aggressive'], adaptivePreflop: true };
    const tight: RuleParams = { ...RULE_PRESETS['tight-aggressive'], adaptivePreflop: true };
    const cards = [c('Kc'), c('Jc')]; // KJs: the class the old budget overflowed on
    const freqs = (p: RuleParams) =>
      choosePreflopIntent({ ...view, hand: { ...view.hand!, myCards: cards } }, p, () => 0)
        .frequencies;
    // The LAG 3-bets this class more often than the tight reference (style kept).
    expect(freqs(lag).raise).toBeGreaterThan(freqs(tight).raise);
  });
});

// ---------------------------------------------------------------------------
// real state-machine fixtures (startHand / applyAction) for the step-2 gate
// ---------------------------------------------------------------------------

interface RoomPlayerLike {
  userId: number;
  username: string;
  displayName: string;
  seat: number;
  stack: number;
  sittingOut: boolean;
  connected: boolean;
  totalBought: number;
  privateStats: boolean;
}

/** A resynced `HeadlessClient` wrapping a real `BettingState`. */
function liveClient(
  st: BettingState,
  opts: { heroSeat: number; cards: CardId[]; history?: PublicAction[] },
): HeadlessClient {
  const client = new HeadlessClient('http://127.0.0.1:1', 'bot', 'pw');
  client.userId = 1 + opts.heroSeat; // seat n is userId n+1
  client.connected = true;
  client.connectionEpoch = 1;
  client.roomStateEpoch = 1;
  client.handContextEpoch = 1;
  (client as unknown as { resyncHandId: string | null }).resyncHandId = 'h1';
  client.handId = 'h1';
  client.seats = st.seats.map((s) => ({ seat: s.seat, userId: 1 + s.seat, username: `p${s.seat}` }));
  client.room = {
    room: {
      id: 'r1',
      name: 'Test',
      joinCode: 'ABC123',
      hostId: 1,
      bankerId: 1,
      coBankerId: null,
      sb: st.sb,
      bb: st.bb,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
    },
    players: st.seats.map(
      (s): RoomPlayerLike => ({
        userId: 1 + s.seat,
        username: `p${s.seat}`,
        displayName: `p${s.seat}`,
        seat: s.seat,
        stack: s.stack,
        sittingOut: false,
        connected: true,
        totalBought: 0,
        privateStats: false,
      }),
    ),
    handActive: true,
  };
  client.betting = st;
  client.myCards = opts.cards;
  client.actionHistory = opts.history ?? [];
  client.actionSeq = (opts.history ?? []).length;
  return client;
}

/** 6-max dealing order: seat 0 SB, 1 BB, 2 UTG, 3 HJ, 4 CO, 5 BTN. */
function sixMaxState(): BettingState {
  return startHand(
    [0, 1, 2, 3, 4, 5].map((seat) => ({ seat, stack: 10_000 })),
    5,
    50,
    100,
  );
}

describe('step 2: raise reopening on the real betting state machine', () => {
  it('mirrors the round: order, raiser excluded, reopened callers re-added', () => {
    let st = sixMaxState();
    st = applyAction(st, 2, { type: 'raise', amount: 250 }); // UTG opens
    st = applyAction(st, 3, { type: 'call' }); // HJ calls
    st = applyAction(st, 4, { type: 'call' }); // CO calls
    st = applyAction(st, 5, { type: 'raise', amount: 750 }); // BTN 3-bets

    // The raising seat rebuilds `needToAct` from itself: the earlier callers
    // come back because the raise reopened the round.
    expect(st.needToAct).toEqual([0, 1, 2, 3, 4]);
    expect(st.needToAct).not.toContain(5); // the raiser never owes its own action
    expect(st.needToAct).toContain(3); // HJ, a reopened caller
    expect(st.needToAct).toContain(4); // CO, a reopened caller
    expect(st.toAct).toBe(0);

    const history = [act(2, 'raise', 250), act(3, 'call'), act(4, 'call'), act(5, 'raise', 750)];
    const client = liveClient(st, { heroSeat: 2, cards: [c('Ac'), c('Kd')], history });
    const view = buildDecisionView(client);
    expect(view.needToActSeats).toEqual([0, 1, 2, 3, 4]);

    const ctx = derivePreflopContext(view);
    expect(ctx.heroSeat).toBe(2);
    expect(ctx.needToActTracked).toBe(true);
    expect(ctx.needToActSeats).toEqual([0, 1, 2, 3, 4]);
    expect(ctx.needToActSeats!.includes(ctx.heroSeat)).toBe(true); // hero still owes
    expect(ctx.spot).toBe('facing3Bet');
    // UTG has HJ/CO/SB/BB behind it again after the 3-bet; the flat "acted at
    // some point" set would see only the two blinds.
    expect(ctx.behindUnacted).toBe(4);

    const untracked = derivePreflopContext({ ...view, needToActSeats: undefined });
    expect(untracked.needToActTracked).toBe(false);
    expect(untracked.behindUnacted).toBe(2); // legacy inference: only the blinds
  });

  it('drops folded and all-in seats when the raise rebuilds needToAct', () => {
    let st = sixMaxState();
    st = applyAction(st, 2, { type: 'raise', amount: 250 }); // UTG opens
    st = applyAction(st, 3, { type: 'fold' }); // HJ folds
    st = applyAction(st, 4, { type: 'call' }); // CO calls
    // SB is all-in before the 3-bet: it cannot act, so it must not be pending.
    st.seats.find((s) => s.seat === 0)!.allIn = true;
    st = applyAction(st, 5, { type: 'raise', amount: 750 }); // BTN 3-bets

    expect(st.needToAct).not.toContain(5); // raiser
    expect(st.needToAct).not.toContain(3); // folded
    expect(st.needToAct).not.toContain(0); // all-in
    expect(st.needToAct).toEqual([1, 2, 4]); // BB, UTG, CO in order
  });
});

describe('step 2: legacy server and empty/hero-absent pending', () => {
  it('buildDecisionView survives a state with no needToAct and falls back', () => {
    let st = sixMaxState();
    st = applyAction(st, 2, { type: 'raise', amount: 250 }); // UTG opens
    // An older server's `betting_state.state` predates `needToAct`.
    delete (st as unknown as { needToAct?: number[] }).needToAct;

    const client = liveClient(st, {
      heroSeat: 1,
      cards: [c('Ac'), c('Kd')],
      history: [act(2, 'raise', 250)],
    });
    const view = buildDecisionView(client); // must not throw on [...undefined]

    expect(view.needToActSeats).toBeUndefined();
    const ctx = derivePreflopContext(view);
    expect(ctx.needToActTracked).toBe(false);
    expect(ctx.needToActSeats).toBeNull();
    expect(ctx.spot).toBe('facingOpen');
    expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(false);
    expect(measuredWidth(view, ADAPTIVE)).toBeCloseTo(measuredWidth(view, LEGACY), 12);
  });

  it('refuses an empty needToActSeats snapshot and falls back to legacy', () => {
    const view = faceOpenView(6, 1, 2, [c('Ac'), c('Kd')]);
    const empty: DecisionView = { ...view, needToActSeats: [] };
    const ctx = derivePreflopContext(empty);
    expect(ctx.needToActTracked).toBe(true); // the server did supply the field
    expect(ctx.needToActSeats).toEqual([]);
    expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(false);
    expect(measuredWidth(empty, ADAPTIVE)).toBeCloseTo(measuredWidth(empty, LEGACY), 12);
  });

  it('refuses a tracked snapshot that does not list the hero', () => {
    const view = faceOpenView(6, 1, 2, [c('Ac'), c('Kd')]); // hero = BB (seat 1)
    const absent: DecisionView = { ...view, needToActSeats: [0] }; // SB only
    const ctx = derivePreflopContext(absent);
    expect(ctx.needToActTracked).toBe(true);
    expect(ctx.needToActSeats!.includes(ctx.heroSeat)).toBe(false);
    expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(false);
    expect(measuredWidth(absent, ADAPTIVE)).toBeCloseTo(measuredWidth(absent, LEGACY), 12);
  });

  it('refuses when the hero is inactive even though pending lists it', () => {
    const view = faceOpenView(6, 1, 2, [c('Ac'), c('Kd')]); // hero = BB, toAct = BB
    for (const state of [{ folded: true }, { allIn: true }, { sittingOut: true }] as const) {
      const dead: DecisionView = { ...view, me: { ...view.me!, ...state } };
      const ctx = derivePreflopContext(dead);
      // The snapshot still tracks a non-empty pending list containing the hero,
      // but a folded/all-in/sitting hero cannot be deciding.
      expect(ctx.needToActTracked).toBe(true);
      expect(ctx.needToActSeats!.includes(ctx.heroSeat)).toBe(true);
      expect(ctx.heroActive).toBe(false);
      expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(false);
      expect(measuredWidth(dead, ADAPTIVE)).toBeCloseTo(measuredWidth(dead, LEGACY), 12);
    }
  });

  it('refuses when the hero is pending but it is not the hero to act', () => {
    const view = faceOpenView(6, 1, 2, [c('Ac'), c('Kd')]); // hero = BB, toAct = BB
    const notMyTurn: DecisionView = { ...view, hand: { ...view.hand!, toAct: 0 } };
    const ctx = derivePreflopContext(notMyTurn);
    expect(ctx.heroActive).toBe(true);
    expect(ctx.heroToAct).toBe(false);
    expect(ctx.needToActSeats!.includes(ctx.heroSeat)).toBe(true);
    expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(false);
    expect(measuredWidth(notMyTurn, ADAPTIVE)).toBeCloseTo(
      measuredWidth(notMyTurn, LEGACY),
      12,
    );
  });

  it('continueWidthScale is an explicit B0/B1/B8 heuristic ladder', () => {
    expect(continueWidthScale(0)).toBe(1);
    expect(continueWidthScale(1)).toBeCloseTo(1 / 1.08, 12);
    expect(continueWidthScale(8)).toBeCloseTo(1 / 1.64, 12);
    expect(continueWidthScale(0)).toBeGreaterThan(continueWidthScale(1));
    expect(continueWidthScale(1)).toBeGreaterThan(continueWidthScale(8));
  });
});

describe('step 2: deterministic effective-frequency assertions', () => {
  const eff = (view: DecisionView, params: RuleParams, cards: CardId[]) =>
    choosePreflopIntent({ ...view, hand: { ...view.hand!, myCards: cards } }, params, () => 0.5)
      .frequencies;

  it('gives a different effective mix than legacy for the same BB-vs-UTG hand', () => {
    const view = faceOpenView(6, 1, 2, [c('As'), c('5s')]); // BB vs UTG, A5s
    const adaptive = eff(view, ADAPTIVE, [c('As'), c('5s')]);
    const legacy = eff(view, LEGACY, [c('As'), c('5s')]);
    expect(adaptive.raise + adaptive.call).toBeGreaterThan(0);
    expect(
      Math.abs(adaptive.raise - legacy.raise) > 1e-9 ||
        Math.abs(adaptive.call - legacy.call) > 1e-9,
    ).toBe(true);
  });

  it('keeps AA a continuation under cold-call scaling (never a fold)', () => {
    const view = faceOpenView(6, 5, 2, [c('Ac'), c('Ad')]); // BTN vs UTG
    const f = eff(view, ADAPTIVE, [c('Ac'), c('Ad')]);
    expect(f.raise + f.call).toBeCloseTo(1, 9);
    const intent = choosePreflopIntent(
      { ...view, hand: { ...view.hand!, myCards: [c('Ac'), c('Ad')] } },
      ADAPTIVE,
      () => 0.999,
    ).intent;
    expect(intent).not.toBe('fold');
  });

  it('narrows an edge flat call as behindUnacted grows (B0 vs B4)', () => {
    const cards = [c('9s'), c('8s')]; // pure flat call: no 3-bet value/bluff
    const wideBase = faceOpenView(6, 5, 2, cards); // BTN, hero last
    const wide: DecisionView = { ...wideBase, needToActSeats: [5] }; // B0
    const tight = faceOpenView(6, 3, 2, cards); // HJ, four behind -> B4
    expect(derivePreflopContext(wide).behindUnacted).toBe(0);
    expect(derivePreflopContext(tight).behindUnacted).toBe(4);
    expect(adaptivePreflopAvailable(derivePreflopContext(wide), ADAPTIVE)).toBe(true);
    expect(adaptivePreflopAvailable(derivePreflopContext(tight), ADAPTIVE)).toBe(true);
    const w = eff(wide, ADAPTIVE, cards);
    const t = eff(tight, ADAPTIVE, cards);
    expect(w.call).toBeGreaterThan(t.call);
  });

  it('keeps the legacy KQs bluff alive when Rust has no mapping (COLD_3BET_BLUFF_WEIGHT)', () => {
    // 9-max UTG (behind 8) has no 6-max equivalent, so the Rust provider
    // refuses the pair and the legacy `COLD_3BET_BLUFF.EP` anchor — KQs at
    // `COLD_3BET_BLUFF_WEIGHT` (0.55) — is the entire raise side. This is the
    // path the Rust integration replaced for mapped 6-max seats (at
    // BTN-vs-UTG Rust raises KQs 100%, so the old 6-max legacy assertion no
    // longer holds and must be exercised where the legacy anchor still rules).
    expect(rustVsOpenRaiseTable(2, 8)).toBeNull(); // hero BTN behind 2, opener UTG behind 8
    const cards = [c('Ks'), c('Qs')];
    const wideBase = faceOpenView(9, 8, 2, cards); // BTN
    const wide: DecisionView = { ...wideBase, needToActSeats: [8] }; // B0
    const tight = faceOpenView(9, 6, 2, cards); // HJ, four behind -> B4
    const w = eff(wide, ADAPTIVE, cards);
    const t = eff(tight, ADAPTIVE, cards);
    expect(w.raise).toBeGreaterThan(0); // legacy bluff raise, not swallowed
    expect(t.raise).toBeGreaterThan(0);
    expect(t.call).toBeLessThan(w.call); // only the legacy flat call narrows
  });

  it('hands KQs to the Rust raise at a mapped spot (BTN-vs-UTG, the old 6-max test)', () => {
    // The *mapped* counterpart of the test above, and the replacement for the
    // old 6-max KQs assertion that can no longer hold. At BTN-vs-UTG the Rust
    // export raises KQs 100%, and the merge writes that exact frequency: the
    // legacy `COLD_3BET_BLUFF` 0.55 bluff and its 0.45 flat call are both
    // consumed by the Rust raise. Pin the new contract so the old spot keeps
    // its regression coverage; the old behaviour (raise 0.3548…, call 0.6451…)
    // is asserted absent at the bottom.
    expect(rustVsOpenRaiseTable(2, 5)!.raise.get('KQs')).toBe(1); // Rust provider
    const cards = [c('Ks'), c('Qs')];
    const wideBase = faceOpenView(6, 5, 2, cards); // BTN vs UTG
    const wide: DecisionView = { ...wideBase, needToActSeats: [5] }; // B0
    const w = eff(wide, ADAPTIVE, cards);
    expect(w.raise).toBe(1); // merged: Rust raise survives untouched
    expect(w.call).toBe(0); // ...and consumes the legacy flat call
    // Discrimination guard: the assertion above really does catch the old
    // legacy mix rather than passing against anything.
    const legacy = eff(wide, LEGACY, cards);
    expect(legacy.raise).not.toBe(1);
    expect(legacy.raise).toBeGreaterThan(0);
  });

  it('uses the Rust mixed raise for KJs and keeps it independent of behindUnacted', () => {
    // KJs is a *mixed* Rust cold 3-bet: 32% at BTN-vs-UTG, 89% at MP-vs-UTG, and
    // a legacy flat call (CALL_VS_OPEN.LP). The raise comes from the Rust
    // provider and must be independent of `behindUnacted`; only the legacy call
    // narrows as more players remain to act behind the hero.
    const cards = [c('Ks'), c('Js')];
    const wideBase = faceOpenView(6, 5, 2, cards); // BTN, hero last
    const wide: DecisionView = { ...wideBase, needToActSeats: [5] }; // B0
    const tight = faceOpenView(6, 3, 2, cards); // HJ, four behind -> B4
    const w = eff(wide, ADAPTIVE, cards);
    const t = eff(tight, ADAPTIVE, cards);
    expect(w.raise).toBeGreaterThan(0);
    expect(t.raise).toBeGreaterThan(0); // the Rust raise is not swallowed
    expect(t.call).toBeLessThan(w.call); // only the flat call narrows
  });
});

// ---------------------------------------------------------------------------
// step 3: derived adaptive charts for the remaining spots (ISO / 3-bet / 4-bet)
// ---------------------------------------------------------------------------

/** A view with an explicit preflop auction and (optional) current-round pending. */
function auctionView(args: {
  n: number;
  heroSeat: number;
  history: PublicAction[];
  pending?: number[];
  currentBet: number;
  states?: Record<number, Partial<DecisionSeat>>;
}): DecisionView {
  const base = nHandedView(args.n, args.heroSeat, []);
  const view: DecisionView = {
    ...base,
    hand: { ...base.hand!, currentBet: args.currentBet, toAct: args.heroSeat },
    actionHistory: args.history,
    ...(args.pending ? { needToActSeats: args.pending } : {}),
  };
  return args.states ? withStates(view, args.states) : view;
}

const DERIVED_ANCHORS: ReadonlyArray<{ name: string; entries: RangeEntry[] }> = [
  { name: 'iso-lp', entries: [{ range: ISO_RANGES.LP, action: 'raise', weight: 1, role: 'value' }] },
  { name: 'facing3bet', entries: [...FACING_3BET_4BET, ...FACING_3BET_CALL] },
  { name: 'facing3bet-cold', entries: COLD_3BET_COLD },
  { name: 'facing4bet', entries: FACING_4BET_PLUS },
];

function derivedChart(entries: RangeEntry[], behind: number) {
  return buildDerivedChart({
    id: `test-${behind}`,
    situation: 'facing3Bet',
    actor: 'BTN',
    actorSlot: behind,
    opener: null,
    openerSlot: null,
    behindUnacted: behind,
    activeCount: behind + 1,
    seats: 6,
    format: '6max',
    depthBB: 100,
    usage: 'test',
    entries,
    scale: continueWidthScale(behind),
  });
}

describe('step 3: derived chart construction', () => {
  it('builds 169-cell normalised charts with explicit value/bluff roles', () => {
    for (const { entries } of DERIVED_ANCHORS) {
      const chart = derivedChart(entries, 4);
      expect(Object.keys(chart.mix)).toHaveLength(169);
      expect(worstCellDeviation(chart) * 1326).toBeLessThan(0.01);
      const roles = new Set(HAND_KEYS.map((k) => chart.mix[k]!.raiseRole));
      expect(roles.has('value')).toBe(true);
    }
    // The facing-3bet anchor keeps its blocker bluff raise as `bluff`.
    const f3 = derivedChart([...FACING_3BET_4BET, ...FACING_3BET_CALL], 4);
    expect(HAND_KEYS.some((k) => f3.mix[k]!.raiseRole === 'bluff')).toBe(true);
    // A tapered *value* raise (ISO 99: mixed raise/fold after the taper) keeps
    // its explicit `value` role rather than being relabelled a bluff.
    const iso = derivedChart(
      [{ range: ISO_RANGES.LP, action: 'raise', weight: 1, role: 'value' }],
      8,
    );
    expect(iso.mix['99']!.raise).toBeGreaterThan(0);
    expect(iso.mix['99']!.fold).toBeGreaterThan(0);
    expect(iso.mix['99']!.raiseRole).toBe('value');
  });

  it('tapers width strictly monotonically in behindUnacted and never vanishes', () => {
    for (const { entries } of DERIVED_ANCHORS) {
      const widths = Array.from({ length: 9 }, (_, b) => chartWidth(derivedChart(entries, b)));
      for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeLessThan(widths[i - 1]!);
      expect(widths[8]!).toBeGreaterThan(0);
    }
  });

  it('holds AA/KK full and never folds a premium under the taper', () => {
    const entries: RangeEntry[] = [
      { range: 'AA, KK, QQ, AKs, 72o', action: 'raise', weight: 1, role: 'value' },
    ];
    const chart = derivedChart(entries, 8);
    for (const k of ['AA', 'KK']) {
      expect(chart.mix[k]!.raise + chart.mix[k]!.allin).toBeCloseTo(1, 9);
      expect(chart.mix[k]!.fold).toBeCloseTo(0, 9);
    }
    expect(chart.mix['QQ']!.raise).toBeLessThan(1); // non-premium tapered
    expect(chart.mix['72o']!.raise).toBeLessThan(1);

    const raw = rangeEntriesToRawSpot(entries);
    expect(taperRawSpot(raw, 1)).toBe(raw); // identity at scale 1
    expect(rawSpotWidth(taperRawSpot(raw, 0.5))).toBeLessThan(rawSpotWidth(raw));
    expect(DERIVED_ANCHOR_PREMIUM.has('AA')).toBe(true);
    expect(DERIVED_ANCHOR_PREMIUM.has('QQ')).toBe(false);
  });

  it('multiwayWidthScale is a monotone caller-squeeze ladder', () => {
    expect(multiwayWidthScale(0)).toBe(1);
    expect(multiwayWidthScale(1)).toBeCloseTo(1 / 1.15, 12);
    expect(multiwayWidthScale(0)).toBeGreaterThan(multiwayWidthScale(2));
    expect(multiwayWidthScale(2)).toBeGreaterThan(multiwayWidthScale(6));
  });
});

describe('step 3: end-to-end derived spots', () => {
  const limped = (hero: number) =>
    auctionView({ n: 6, heroSeat: hero, history: [act(2, 'call')], currentBet: 100 });
  const facing3Bet = () =>
    auctionView({
      n: 6,
      heroSeat: 2,
      history: [act(2, 'raise', 250), act(3, 'fold'), act(4, 'raise', 750)],
      pending: [2, 5, 0, 1],
      currentBet: 750,
      states: { 3: { folded: true } },
    });
  const facing3BetCold = () =>
    auctionView({
      n: 6,
      heroSeat: 5,
      history: [act(2, 'raise', 250), act(4, 'raise', 750)],
      pending: [5, 0, 1],
      currentBet: 750,
    });
  const facing4BetPlus = () =>
    auctionView({
      n: 6,
      heroSeat: 5,
      history: [act(2, 'raise', 250), act(4, 'raise', 750), act(2, 'raise', 2000)],
      pending: [5, 0, 1],
      currentBet: 2000,
    });
  const facingOpenMultiway = () =>
    auctionView({
      n: 6,
      heroSeat: 5,
      history: [act(2, 'raise', 250), act(3, 'call')],
      pending: [5, 0, 1],
      currentBet: 250,
    });

  const cases: ReadonlyArray<{ name: string; spot: string; slot: number; view: () => DecisionView }> = [
    { name: 'limped BTN', spot: 'limped', slot: 2, view: () => limped(5) },
    { name: 'facing3Bet UTG', spot: 'facing3Bet', slot: 3, view: facing3Bet },
    { name: 'facing3BetCold BTN', spot: 'facing3BetCold', slot: 2, view: facing3BetCold },
    { name: 'facing4BetPlus BTN', spot: 'facing4BetPlus', slot: 2, view: facing4BetPlus },
    { name: 'facingOpenMultiway BTN', spot: 'facingOpenMultiway', slot: 2, view: facingOpenMultiway },
  ];

  it('routes each remaining spot to adaptive only with the flag on', () => {
    for (const { name, spot, slot, view } of cases) {
      const ctx = derivePreflopContext(view());
      expect(ctx.spot, name).toBe(spot);
      expect(ctx.actorSlot, name).toBe(slot);
      expect(adaptivePreflopAvailable(ctx, ADAPTIVE), name).toBe(true);
      expect(adaptivePreflopAvailable(ctx, LEGACY), name).toBe(false);
    }
  });

  it('gives the derived spots a genuinely different width than legacy', () => {
    for (const { name, view } of cases) {
      const card = [c('Ac'), c('Kd')];
      const v = { ...view(), hand: { ...view().hand!, myCards: card } };
      // The cold 3-bet / 4-bet anchors are only a few percent wide, so the
      // absolute delta is small; any non-zero delta proves the route changed.
      expect(Math.abs(measuredWidth(v, ADAPTIVE) - measuredWidth(v, LEGACY)), name).toBeGreaterThan(
        1e-4,
      );
    }
  });

  it('limped width rises as players behind fall (BTN > CO > HJ)', () => {
    const widths = [3, 4, 5].map((hero) =>
      measuredWidth({ ...limped(hero), hand: { ...limped(hero).hand!, myCards: [c('Ac'), c('Kd')] } }, ADAPTIVE),
    );
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
  });

  it('keeps a raise money in every derived spot even when tapered', () => {
    for (const { name, view } of cases) {
      const cards = [c('Ks'), c('Qs')]; // a 3-bet bluff / value-ish class
      const f = choosePreflopIntent(
        { ...view(), hand: { ...view().hand!, myCards: cards } },
        ADAPTIVE,
        () => 0.5,
      ).frequencies;
      expect(f.raise + f.call, name).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('requires the current-round pending list for every raised spot', () => {
    // Drop the pending list: the round can reopen, so adaptive must refuse.
    const noPending = auctionView({
      n: 6,
      heroSeat: 5,
      history: [act(2, 'raise', 250), act(4, 'raise', 750)],
      currentBet: 750,
    });
    expect(adaptivePreflopAvailable(derivePreflopContext(noPending), ADAPTIVE)).toBe(false);
    const empty = auctionView({
      n: 6,
      heroSeat: 5,
      history: [act(2, 'raise', 250), act(4, 'raise', 750)],
      pending: [],
      currentBet: 750,
    });
    expect(adaptivePreflopAvailable(derivePreflopContext(empty), ADAPTIVE)).toBe(false);
    const absent = auctionView({
      n: 6,
      heroSeat: 5,
      history: [act(2, 'raise', 250), act(4, 'raise', 750)],
      pending: [0, 1],
      currentBet: 750,
    });
    expect(adaptivePreflopAvailable(derivePreflopContext(absent), ADAPTIVE)).toBe(false);
    // Limped needs no pending (nothing can have reopened), but HU stays legacy.
    const huLimped: DecisionView = {
      ...nHandedView(2, 1, []),
      actionHistory: [act(0, 'call')],
      hand: { ...nHandedView(2, 1, []).hand!, toAct: 1 },
    };
    const huCtx = derivePreflopContext(huLimped);
    expect(huCtx.spot).toBe('limped');
    expect(adaptivePreflopAvailable(huCtx, ADAPTIVE)).toBe(false);
  });

  it('keeps HU limped on legacy by design (there is no HU limp-iso anchor)', () => {
    // Intentional design decision, not an oversight: a heads-up BB facing a SB
    // limp is not a multiway isolation raise. The legacy `ISO_RANGES` are
    // position-group (non-HU) tables and the solver subsets have no HU
    // limp-iso anchor, so importing the multiway anchor into a 2-handed pot
    // would be unsupported. `adaptivePreflopAvailable`'s `limped` branch pins
    // HU to legacy for exactly this reason; changing it needs a dedicated HU
    // anchor, not a gate tweak.
    const hu = auctionView({ n: 2, heroSeat: 1, history: [act(0, 'call')], currentBet: 100 });
    const ctx = derivePreflopContext(hu);
    expect(ctx.spot).toBe('limped');
    expect(ctx.headsUp).toBe(true);
    expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(false);
    expect(adaptivePreflopAvailable(ctx, LEGACY)).toBe(false);
    // ...and the flag cannot move it: flag on == flag off, per hand.
    const withCards = { ...hu, hand: { ...hu.hand!, myCards: [c('Ac'), c('Kd')] } };
    expect(measuredWidth(withCards, ADAPTIVE)).toBeCloseTo(measuredWidth(withCards, LEGACY), 12);
  });

  it('routes limped by real policy view: HU legacy, 3/6/9 adaptive and narrowing with behind', () => {
    // Real policy views (not a chart-level probe) for 2/3/6/9-handed limped
    // pots. Within each table the hero and their anchor position are fixed, and
    // only the server-supplied current-round pending list shrinks, so the width
    // ordering isolates the `behindUnacted` taper from the anchor choice.
    const orderFor = (n: number) => preflopActionOrder(Array.from({ length: n }, (_, i) => i));
    const cases = [
      { n: 2, hero: 1 }, // HU BB vs SB limp -> legacy (see the test above)
      { n: 3, hero: 0 },
      { n: 6, hero: 3 },
      { n: 9, hero: 3 },
    ];
    for (const { n, hero } of cases) {
      const order = orderFor(n);
      const limper = order[0]!;
      const idx = order.indexOf(hero);
      const after = order.slice(idx + 1);
      const samples: Array<{ behind: number; width: number }> = [];
      for (let behind = after.length; behind >= 0; behind--) {
        const view = auctionView({
          n,
          heroSeat: hero,
          history: [act(limper, 'call')],
          currentBet: 100,
          pending: [hero, ...after.slice(0, behind)],
        });
        const ctx = derivePreflopContext(view);
        expect(ctx.spot, `n=${n}`).toBe('limped');
        if (n === 2) {
          // Pinned to legacy by design (no HU limp-iso anchor).
          expect(adaptivePreflopAvailable(ctx, ADAPTIVE), 'HU limped stays legacy').toBe(false);
          expect(behind, 'HU limped has no behind').toBe(0);
          continue;
        }
        expect(adaptivePreflopAvailable(ctx, ADAPTIVE), `n=${n} behind=${behind}`).toBe(true);
        expect(ctx.behindUnacted, `n=${n} behind=${behind}`).toBe(behind);
        samples.push({
          behind,
          width: measuredWidth(
            { ...view, hand: { ...view.hand!, myCards: [c('Ac'), c('Kd')] } },
            ADAPTIVE,
          ),
        });
      }
      // Same hero/anchor: fewer players behind must never be tighter.
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i]!.width, `n=${n} behind ${samples[i]!.behind}`).toBeGreaterThan(
          samples[i - 1]!.width,
        );
      }
    }
  });

  it('keeps the <20BB open-jam on SHORT_JAM_RANGES (separate semantic)', () => {
    // A limped pot at 15BB: the route is adaptive, but the short-stack pipeline
    // (`shortStackMix`) still short-circuits to the position-group jam set, so
    // `22` folds (not in SHORT_JAM_RANGES.LP) while `AA` jams. Sizing / short-
    // stack adaptation is deliberately out of step-3 scope.
    const base = auctionView({ n: 6, heroSeat: 5, history: [act(2, 'call')], currentBet: 100 });
    const short: DecisionView = {
      ...base,
      me: { ...base.me!, stack: 1_500 },
      opponents: base.opponents.map((o) => ({ ...o, stack: 1_500 })),
    };
    const ctx = derivePreflopContext(short);
    expect(ctx.spot).toBe('limped');
    expect(ctx.stackBB).toBeCloseTo(15, 9);
    expect(adaptivePreflopAvailable(ctx, ADAPTIVE)).toBe(true);
    const withCards = (cards: CardId[]): DecisionView => ({
      ...short,
      hand: { ...short.hand!, myCards: cards },
    });
    expect(choosePreflopIntent(withCards([c('2c'), c('2d')]), ADAPTIVE, () => 0.99).intent).toBe(
      'fold',
    );
    expect(choosePreflopIntent(withCards([c('Ac'), c('Ad')]), ADAPTIVE, () => 0.99).intent).toBe(
      'raise',
    );
  });

  it('refuses a raised spot when the snapshot is not the hero live decision', () => {
    const base = facing3BetCold();
    for (const state of [{ folded: true }, { allIn: true }, { sittingOut: true }] as const) {
      const dead: DecisionView = { ...base, me: { ...base.me!, ...state } };
      expect(adaptivePreflopAvailable(derivePreflopContext(dead), ADAPTIVE)).toBe(false);
    }
    const notMyTurn: DecisionView = { ...base, hand: { ...base.hand!, toAct: 0 } };
    expect(adaptivePreflopAvailable(derivePreflopContext(notMyTurn), ADAPTIVE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// step 3: flag-off legacy path is unchanged versus the pre-change baseline
// ---------------------------------------------------------------------------

describe('step 3: flag-off differential against the 5f9b12a baseline', () => {
  const BASE_CARDS: CardId[][] = [
    [c('Ac'), c('Ad')],
    [c('Ks'), c('Kd')],
    [c('Ks'), c('Qs')],
    [c('9s'), c('8s')],
    [c('7c'), c('2d')],
    [c('Ah'), c('Kd')],
    [c('Jd'), c('Jc')],
    [c('As'), c('5s')],
    [c('Th'), c('Jh')],
    [c('2c'), c('2d')],
    [c('Qc'), c('Qd')],
    [c('4h'), c('3d')],
  ];

  /**
   * Fine-grained check: `choosePreflopIntent`'s resolved intent, frequencies
   * and derived context must match the pre-step-3 engine. This deliberately
   * does NOT cover the final legal action, its amount, or the decision reason;
   * `expectDecideBaseline` below is the end-to-end `PolicyDecision` check.
   */
  function expectBaseline(view: DecisionView): void {
    for (const cards of BASE_CARDS) {
      for (const roll of [0.1, 0.5, 0.9]) {
        const v: DecisionView = { ...view, hand: { ...view.hand!, myCards: cards } };
        const cur = choosePreflopIntent(v, LEGACY, () => roll);
        const base = Baseline.choosePreflopIntent(v, LEGACY, () => roll);
        expect({
          intent: cur.intent,
          frequencies: cur.frequencies,
          spot: cur.context.spot,
          slot: cur.context.actorSlot,
          behind: cur.context.behindUnacted,
        }).toEqual({
          intent: base.intent,
          frequencies: base.frequencies,
          spot: base.context.spot,
          slot: base.context.actorSlot,
          behind: base.context.behindUnacted,
        });
      }
    }
  }

  it('choosePreflopIntent matches the baseline intent/frequencies/context across spots', () => {
    expectBaseline(nHandedView(9, 2, [])); // unopened 9-max
    expectBaseline(nHandedView(2, 0, [])); // HU first-in
    expectBaseline(
      auctionView({ n: 6, heroSeat: 5, history: [act(2, 'call')], currentBet: 100 }), // limped
    );
    expectBaseline(faceOpenView(6, 1, 2, [])); // BB vs open
    expectBaseline(
      auctionView({
        n: 6,
        heroSeat: 2,
        history: [act(2, 'raise', 250), act(3, 'fold'), act(4, 'raise', 750)],
        pending: [2, 5, 0, 1],
        currentBet: 750,
        states: { 3: { folded: true } },
      }),
    ); // facing 3-bet
    expectBaseline(
      auctionView({
        n: 6,
        heroSeat: 5,
        history: [act(2, 'raise', 250), act(4, 'raise', 750)],
        pending: [5, 0, 1],
        currentBet: 750,
      }),
    ); // cold 3-bet
    expectBaseline(
      auctionView({
        n: 6,
        heroSeat: 5,
        history: [act(2, 'raise', 250), act(4, 'raise', 750), act(2, 'raise', 2000)],
        pending: [5, 0, 1],
        currentBet: 2000,
      }),
    ); // 4-bet+
    // <20BB short-stack path (SHORT_JAM_RANGES) must also be untouched.
    const short = nHandedView(6, 5, []);
    expectBaseline({
      ...short,
      me: { ...short.me!, stack: 1_500 },
      opponents: short.opponents.map((o) => ({ ...o, stack: 1_500 })),
    });
  });

  // --- end-to-end: the final PolicyDecision, not just the intent ------------

  /** A plausible, already-normalised preflop legal-action set for a view. */
  function legalFor(view: DecisionView, maxRaiseTo = 20_000): DecisionLegalActions {
    const currentBet = view.hand?.currentBet ?? 0;
    const committed = view.me?.committed ?? 0;
    const callAmount = Math.max(0, currentBet - committed);
    return {
      canCheck: callAmount === 0,
      canCall: callAmount > 0,
      callAmount,
      canBet: false,
      canRaise: true,
      minRaiseTo: Math.max(currentBet * 2, 200),
      maxRaiseTo,
    };
  }

  /**
   * The real differential: the *final* `RulePolicy.decide` output — the legal
   * action, its amount and the reason — must be identical to the 5f9b12a
   * engine for every input when `adaptivePreflop` is off. `RulePolicy` itself is
   * byte-unchanged between 5f9b12a and HEAD, so the only possible divergence is
   * `choosePreflopIntent`; the baseline fixture redirects that to the old
   * engine. Several seeds cover raise / call / fold rolls, so the sizing path,
   * the short-stack all-in mapping and the `reason` string are all exercised.
   */
  function expectDecideBaseline(view: DecisionView, maxRaiseTo = 20_000): void {
    const la = legalFor(view, maxRaiseTo);
    for (const cards of BASE_CARDS) {
      for (const seed of [1, 2, 3, 5, 8]) {
        const v: DecisionView = {
          ...view,
          legalActions: la,
          hand: { ...view.hand!, myCards: cards },
        };
        const cur = new RulePolicy({ params: LEGACY, seed }).decide(v);
        const base = new BaselineRule.RulePolicy({ params: LEGACY, seed }).decide(v);
        expect({ cards, seed, cur }).toEqual({ cards, seed, cur: base });
      }
    }
  }

  it('final RulePolicy.decide matches the baseline decision (action + amount + reason)', () => {
    expectDecideBaseline(nHandedView(9, 2, [])); // unopened 9-max
    expectDecideBaseline(nHandedView(2, 0, [])); // HU first-in
    expectDecideBaseline(
      auctionView({ n: 6, heroSeat: 5, history: [act(2, 'call')], currentBet: 100 }), // limped
    );
    expectDecideBaseline(faceOpenView(6, 1, 2, [])); // BB vs open
    expectDecideBaseline(
      auctionView({
        n: 6,
        heroSeat: 2,
        history: [act(2, 'raise', 250), act(3, 'fold'), act(4, 'raise', 750)],
        pending: [2, 5, 0, 1],
        currentBet: 750,
        states: { 3: { folded: true } },
      }),
    ); // facing 3-bet
    expectDecideBaseline(
      auctionView({
        n: 6,
        heroSeat: 5,
        history: [act(2, 'raise', 250), act(4, 'raise', 750)],
        pending: [5, 0, 1],
        currentBet: 750,
      }),
    ); // cold 3-bet
    expectDecideBaseline(
      auctionView({
        n: 6,
        heroSeat: 5,
        history: [act(2, 'raise', 250), act(4, 'raise', 750), act(2, 'raise', 2000)],
        pending: [5, 0, 1],
        currentBet: 2000,
      }),
    ); // 4-bet+
    // <20BB short-stack path (SHORT_JAM_RANGES + all-in mapping) must be untouched.
    const short = nHandedView(6, 5, []);
    expectDecideBaseline(
      {
        ...short,
        me: { ...short.me!, stack: 1_500 },
        opponents: short.opponents.map((o) => ({ ...o, stack: 1_500 })),
      },
      1_500,
    );
  });

  it('the baseline really is the pre-step-3 engine: with the flag on the final decision differs', () => {
    // Positive control (the reverse verification): leave `adaptivePreflop` on
    // and the final decision diverges from the baseline for at least one input,
    // so the flag-off equality above is not vacuous.
    const view = auctionView({
      n: 6,
      heroSeat: 5,
      history: [act(2, 'raise', 250), act(4, 'raise', 750)],
      pending: [5, 0, 1],
      currentBet: 750,
    });
    const la = legalFor(view);
    let adaptiveDiffs = 0;
    for (const cards of BASE_CARDS) {
      for (const seed of [1, 2, 3, 5, 8]) {
        const v: DecisionView = {
          ...view,
          legalActions: la,
          hand: { ...view.hand!, myCards: cards },
        };
        const on = new RulePolicy({ params: ADAPTIVE, seed }).decide(v);
        const base = new BaselineRule.RulePolicy({ params: ADAPTIVE, seed }).decide(v);
        if (JSON.stringify(on) !== JSON.stringify(base)) adaptiveDiffs++;
      }
    }
    expect(adaptiveDiffs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// default direction: adaptive is ON for every preset, legacy is the opt-out
// ---------------------------------------------------------------------------

describe('adaptive preflop default direction', () => {
  const PRESET_KINDS: PolicyKind[] = [
    'tight-aggressive',
    'loose-aggressive',
    'calling-station',
    'constrained-random',
  ];
  const DEFAULT_CARDS: CardId[][] = [
    [c('Ac'), c('Kd')],
    [c('Ac'), c('Ad')],
    [c('7c'), c('2d')],
    [c('5c'), c('5d')],
  ];
  const legal = (view: DecisionView): DecisionLegalActions => {
    const currentBet = view.hand?.currentBet ?? 0;
    const committed = view.me?.committed ?? 0;
    const callAmount = Math.max(0, currentBet - committed);
    return {
      canCheck: callAmount === 0,
      canCall: callAmount > 0,
      callAmount,
      canBet: false,
      canRaise: true,
      minRaiseTo: Math.max(currentBet * 2, 200),
      maxRaiseTo: 20_000,
    };
  };

  it('ships with ADAPTIVE_PREFLOP_DEFAULT on and every preset opting in', () => {
    expect(ADAPTIVE_PREFLOP_DEFAULT).toBe(true);
    for (const kind of PRESET_KINDS) {
      expect(RULE_PRESETS[kind].adaptivePreflop, kind).toBe(true);
    }
  });

  it('routes all four default presets to the adaptive charts (not the legacy tables)', () => {
    // 9-max UTG first-in: headcount reliable, history complete, hero to act and
    // nobody behind has acted. Pre-flip this exact view ran the legacy UTG RFI
    // table; the default now serves the B8 adaptive chart.
    const view = nHandedView(9, 2, [c('Ac'), c('Kd')]);
    const ctx = derivePreflopContext(view);
    const adaptiveCoreWidth = adaptiveRfiCoreWidth(rfiChartForSlot(8)!);
    const legacyWidth = measuredWidth(view, { ...RULE_PRESETS['tight-aggressive'], adaptivePreflop: false });

    for (const kind of PRESET_KINDS) {
      const params = RULE_PRESETS[kind];
      // The route resolver says adaptive for the untouched preset...
      expect(adaptivePreflopAvailable(ctx, params), kind).toBe(true);
      expect(preflopMixCacheKey(ctx, params), kind).toMatch(/\|adaptive$/);
      // ...and the untouched preset compiles the *same* mix as an explicit
      // `adaptivePreflop:true`, while diverging from the explicit legacy route.
      expect(measuredWidth(view, params), kind).toBe(measuredWidth(view, { ...params, adaptivePreflop: true }));
      expect(Math.abs(measuredWidth(view, params) - legacyWidth), kind).toBeGreaterThan(0.01);
    }
    // Decisive mix identity: tight-aggressive (preflopScale 1) folds the
    // adaptive `marginal` edge layer, so its measured width is exactly the
    // chart's pure-value core — not the full chart width.
    expect(measuredWidth(view, RULE_PRESETS['tight-aggressive'])).toBeCloseTo(adaptiveCoreWidth, 9);
    expect(legacyWidth).toBeCloseTo(parseRange(RFI_RANGES.UTG).combos / COMBOS.length, 9);
  });

  it('the explicit kill-switch is byte-identical to the frozen baseline for every preset', () => {
    const views: DecisionView[] = [
      nHandedView(9, 2, []), // unopened 9-max
      nHandedView(6, 5, []), // 6-max BTN first-in
      nHandedView(2, 0, []), // HU first-in
      auctionView({ n: 6, heroSeat: 5, history: [act(2, 'call')], currentBet: 100 }), // limped
      faceOpenView(6, 1, 2, []), // BB vs open
      auctionView({
        n: 6,
        heroSeat: 5,
        history: [act(2, 'raise', 250), act(4, 'raise', 750)],
        pending: [5, 0, 1],
        currentBet: 750,
      }), // cold 3-bet
    ];
    for (const kind of PRESET_KINDS) {
      const off: RuleParams = { ...RULE_PRESETS[kind], adaptivePreflop: false };
      for (const view of views) {
        for (const cards of DEFAULT_CARDS) {
          for (const roll of [0.1, 0.5, 0.9]) {
            const v: DecisionView = { ...view, hand: { ...view.hand!, myCards: cards } };
            const cur = choosePreflopIntent(v, off, () => roll);
            const base = Baseline.choosePreflopIntent(v, off, () => roll);
            // Full PreflopChoice equality: intent + frequencies + context +
            // hand class, not just the final action.
            expect({ kind, roll, cur }).toEqual({ kind, roll, cur: base });
          }
        }
      }
    }
  });

  it('the kill-switch also matches the frozen RulePolicy decision (action + amount + reason)', () => {
    const view = faceOpenView(6, 1, 2, []);
    const v: DecisionView = {
      ...view,
      legalActions: legal(view),
      hand: { ...view.hand!, myCards: [c('Ac'), c('Kd')] },
    };
    for (const kind of PRESET_KINDS) {
      const off: RuleParams = { ...RULE_PRESETS[kind], adaptivePreflop: false };
      for (const seed of [1, 3, 5]) {
        const cur = new RulePolicy({ params: off, seed }).decide(v);
        const base = new BaselineRule.RulePolicy({ params: off, seed }).decide(v);
        expect({ kind, seed, cur }).toEqual({ kind, seed, cur: base });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// adaptive RFI style contract: the four presets must differ by preflopScale
// ---------------------------------------------------------------------------

describe('adaptive RFI style contract (default engine)', () => {
  // `preflopScale` ascends in exactly this order, so the RFI width must too:
  //   tight-aggressive 1.00 < constrained-random 1.10 < calling-station 1.15
  //   < loose-aggressive 1.50
  const RELAXING: PolicyKind[] = [
    'tight-aggressive',
    'constrained-random',
    'calling-station',
    'loose-aggressive',
  ];
  const rfiWidth = (view: DecisionView, kind: PolicyKind) => measuredWidth(view, RULE_PRESETS[kind]);

  function assertGradient(view: DecisionView, label: string): number[] {
    const w = RELAXING.map((k) => rfiWidth(view, k));
    for (let i = 1; i < w.length; i++) {
      expect(w[i]!, `${label}: ${RELAXING[i]} > ${RELAXING[i - 1]}`).toBeGreaterThan(w[i - 1]!);
    }
    // Minimum separations so a future change cannot silently collapse the
    // styles back onto each other (the regression oracle rejected).
    expect(w[1]! - w[0]!, `${label}: random - TAG`).toBeGreaterThan(0.001);
    expect(w[2]! - w[1]!, `${label}: station - random`).toBeGreaterThan(0.0005);
    expect(w[3]! - w[0]!, `${label}: LAG - TAG`).toBeGreaterThan(0.005);
    return w;
  }

  it('9-max UTG first-in (B8): LAG > station > random > TAG', () => {
    const w = assertGradient(nHandedView(9, 2, []), '9max-UTG');
    // A point-scale spread, not the ~0.002 the fixed-chart-width behaviour had.
    expect(w[3]! - w[0]!).toBeGreaterThan(0.01);
  });

  it('9-max BTN late position (B2): the same order holds', () => {
    const w = assertGradient(nHandedView(9, 8, []), '9max-BTN');
    expect(w[3]! - w[0]!).toBeGreaterThan(0.01);
  });

  it('6-max UTG keeps the order too', () => {
    assertGradient(nHandedView(6, 2, []), '6max-UTG');
  });

  it('matches the legacy route order on the same spots', () => {
    const views: Array<[string, DecisionView]> = [
      ['9max-UTG', nHandedView(9, 2, [])],
      ['9max-BTN', nHandedView(9, 8, [])],
      ['6max-UTG', nHandedView(6, 2, [])],
    ];
    const ascending = (w: number[]) => w.every((x, i) => i === 0 || x > w[i - 1]!);
    for (const [label, view] of views) {
      const adaptive = RELAXING.map((k) => rfiWidth(view, k));
      const legacy = RELAXING.map((k) =>
        measuredWidth(view, { ...RULE_PRESETS[k], adaptivePreflop: false }),
      );
      expect(ascending(adaptive), `${label}: adaptive order`).toBe(true);
      expect(ascending(legacy), `${label}: legacy order`).toBe(true);
    }
  });

  it('only wider styles open the marginal edge (TAG folds it)', () => {
    const view = nHandedView(9, 2, []);
    const chart = rfiChartForSlot(8)!;
    // tight-aggressive has preflopScale 1, so the whole `marginal` layer is
    // folded and the width is exactly the chart's pure-value core.
    expect(rfiWidth(view, 'tight-aggressive')).toBeCloseTo(adaptiveRfiCoreWidth(chart), 9);
    // The full chart is wider: the edge exists, it is just style-gated.
    expect(chartWidth(chart)).toBeGreaterThan(rfiWidth(view, 'tight-aggressive'));
    // Even the widest preset stays within the source anchor's width (B5 UTG),
    // so no style is allowed to manufacture range past the provider data.
    expect(rfiWidth(view, 'loose-aggressive')).toBeLessThanOrEqual(
      chartWidth(rfiChartForSlot(5)!),
    );
  });
});
