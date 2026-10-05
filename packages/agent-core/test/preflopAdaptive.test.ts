import { describe, expect, it, vi } from 'vitest';
import { cardFromName, type CardId, type PlayerAction } from '@4am/shared';
import type { DecisionSeat, DecisionView, PublicAction } from '../src/decisionView.js';
import { choosePreflopIntent, derivePreflopContext, adaptivePreflopAvailable, preflopMixCacheKey } from '../src/preflopPolicy.js';
import {
  HAND_KEYS,
  buildChartMix,
  chartLimpShare,
  chartToRangeEntries,
  chartWidth,
  computeBehindUnacted,
  huChart,
  maxReachableWidth,
  preflopActionOrder,
  rawSpotWidth,
  rfiChartForSlot,
  slotsForDealtCount,
  worstCellDeviation,
} from '../src/preflopCharts/index.js';
import { FRLA_RFI, MHL_HU } from '../src/preflopCharts/data/index.js';
import { RFI_RANGES } from '../src/preflopRanges.js';
import { compileRangeMix, mixFor, parseRange } from '../src/rangeParser.js';
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
