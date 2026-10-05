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
  type DecisionSeat,
  type DecisionView,
  type PublicAction,
} from '../src/decisionView.js';
import { HeadlessClient } from '../src/client.js';
import { choosePreflopIntent, derivePreflopContext, adaptivePreflopAvailable, preflopMixCacheKey } from '../src/preflopPolicy.js';
import {
  HAND_KEYS,
  bbDefendChartFor,
  buildChartMix,
  chartLimpShare,
  chartToRangeEntries,
  chartWidth,
  computeBehindUnacted,
  continueWidthScale,
  huChart,
  maxReachableWidth,
  preflopActionOrder,
  rawSpotWidth,
  rescaleRangeMix,
  rfiChartForSlot,
  slotsForDealtCount,
  worstCellDeviation,
} from '../src/preflopCharts/index.js';
import { FRLA_BB_DEFEND, FRLA_RFI, MHL_HU } from '../src/preflopCharts/data/index.js';
import {
  BB_DEFEND,
  CALL_VS_OPEN,
  COLD_3BET_BLUFF,
  COLD_3BET_BLUFF_WEIGHT,
  COLD_3BET_VALUE,
  RFI_RANGES,
} from '../src/preflopRanges.js';
import { compileRangeMix, mixFor, parseRange, type RangeEntry } from '../src/rangeParser.js';
import { RULE_PRESETS, type RuleParams } from '../src/ruleStyles.js';

/**
 * Headcount-adaptive preflop charts (step 1).
 *
 * The tests cover the four accepted properties: width monotonic in behind,
 * no mapping holes for 2..9 handed, the normalisation invariants, and the HU
 * anchors — plus the *fallback* guarantee that the legacy tables are untouched
 * when `adaptivePreflop` is off.
 */

const ADAPTIVE: RuleParams = { ...RULE_PRESETS['tight-aggressive'], adaptivePreflop: true };
const LEGACY = RULE_PRESETS['tight-aggressive'];

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

type Policy = { choosePreflopIntent: typeof choosePreflopIntent };

/** Same as `measuredWidth`, but against a freshly (re)imported) policy module. */
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

    const adaptiveWidth = chartWidth(rfiChartForSlot(8)!);
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

  it('keeps a 3-bet bluff raise alive while the flat call narrows', () => {
    const cards = [c('Ks'), c('Qs')]; // COLD_3BET_BLUFF.EP includes KQs
    const wideBase = faceOpenView(6, 5, 2, cards);
    const wide: DecisionView = { ...wideBase, needToActSeats: [5] }; // B0
    const tight = faceOpenView(6, 3, 2, cards); // B4
    const w = eff(wide, ADAPTIVE, cards);
    const t = eff(tight, ADAPTIVE, cards);
    expect(w.raise).toBeGreaterThan(0);
    expect(t.raise).toBeGreaterThan(0); // the bluff raise is not swallowed
    expect(t.call).toBeLessThan(w.call); // only the flat call narrows
  });
});
