import {
  allHandClasses,
  compileRangeMix,
  parseRange,
  type CompiledMix,
  type RangeEntry,
} from '../rangeParser.js';
import { clamp01 } from '../preflopMath.js';
import { FRLA_BB_DEFEND, FRLA_RFI, MHL_HU } from './data/index.js';
import { MAX_SLOT, canonicalSlot } from './headcount.js';
import type {
  ChartMix,
  ChartSituation,
  ChartSpot,
  ChartSource,
  PreflopChart,
  RawChartFile,
  RawSpot,
  RawTriple,
} from './types.js';

/**
 * Build the headcount-adaptive `preflop-chart/v1` charts from the extracted
 * FRLA / MHL provider subsets.
 *
 * The only real work here is the **per-hand-class width rescaling**: a chart
 * anchored at one width is transformed to a target width, never by multiplying
 * the whole range by a constant (which would fold premiums). Instead:
 *
 *   narrow (target < raw):  p' = clamp((p - t) / (1 - t))
 *   widen  (target > raw):  p' = clamp(p + a*(1 - p))
 *
 * with `t` / `a` solved by bisection so the combo-weighted width hits the
 * target; `p = 1` stays `1` under both. Actions are then split back using the
 * original raise/call ratios.
 *
 * Widening contract: a hand the anchor never plays (`p = 0`) stays folded, so
 * the reachable width is capped at `maxReachableWidth` (see it below). A target
 * above that ceiling throws rather than silently returning a too-narrow chart.
 */

/** Total preflop combos (13*6 + 78*4 + 78*12). */
export const TOTAL_COMBOS = 1326;

/** Combo multiplicity per canonical hand class. */
const COMBOS: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (const h of allHandClasses()) m[h.key] = h.combos;
  return m;
})();

/** All 169 canonical hand-class keys in a stable order. */
export const HAND_KEYS: readonly string[] = allHandClasses().map((h) => h.key);

/** behind-unacted slot -> source RFI spot for B1..B5. */
const SLOT_TO_SPOT: Record<number, string> = {
  1: 'SB-RFI',
  2: 'BTN-RFI',
  3: 'CO-RFI',
  4: 'MP-RFI',
  5: 'UTG-RFI',
};

/** Human-readable canonical label per slot (documentation only). */
const SLOT_ACTOR: Record<number, string> = {
  0: 'BB',
  1: 'SB',
  2: 'BTN',
  3: 'CO',
  4: 'MP/HJ',
  5: 'UTG/LJ',
  6: 'MP',
  7: 'UTG1',
  8: 'UTG',
};

const UTG_WIDTH = 0.175546; // measured B5 (FRLA UTG-RFI) participation

/**
 * Target participation width per behind-unacted slot. B1..B5 are the measured
 * FRLA anchor widths (identity transform); B6..B8 are the 9-max tail
 * extrapolation `W(B) = 0.1755 * exp(-0.1089 * (B - 5))`.
 */
export function slotTargetWidth(slot: number): number {
  if (slot <= 5) return NaN; // identity: use the anchor chart's own width
  return UTG_WIDTH * Math.exp(-0.1089 * (slot - 5));
}

function participation(t: RawTriple): number {
  return t[0] + t[1] + t[2];
}

/** Combo-weighted participation of a raw spot, as a fraction of all combos. */
export function rawSpotWidth(spot: RawSpot): number {
  let sum = 0;
  for (const key of HAND_KEYS) {
    const t = spot[key];
    if (!t) continue;
    sum += (COMBOS[key] ?? 0) * participation(t);
  }
  return sum / TOTAL_COMBOS;
}

function widthAfterNarrow(spot: RawSpot, t: number): number {
  const d = 1 - t;
  let sum = 0;
  for (const key of HAND_KEYS) {
    const p = spot[key] ? participation(spot[key]!) : 0;
    if (p > 0) sum += (COMBOS[key] ?? 0) * clamp01((p - t) / d);
  }
  return sum / TOTAL_COMBOS;
}

function widthAfterWiden(spot: RawSpot, a: number): number {
  let sum = 0;
  for (const key of HAND_KEYS) {
    const p = spot[key] ? participation(spot[key]!) : 0;
    if (p > 0) sum += (COMBOS[key] ?? 0) * clamp01(p + a * (1 - p));
  }
  return sum / TOTAL_COMBOS;
}

/**
 * Upper bound on widening: as `a -> 1`, every hand that participates at all
 * (`p > 0`) reaches `p' = 1`, while a hand the anchor never plays (`p = 0`,
 * explicit or absent) stays folded by the `p > 0` guard. So no widening target
 * above the combo share of the anchor's participating classes is reachable —
 * widening can rescue *frequency*, but it never invents a class the chart does
 * not play. `buildChartMix` rejects a target above this ceiling instead of
 * silently returning the wrong (clamped) width.
 */
export function maxReachableWidth(spot: RawSpot): number {
  let sum = 0;
  for (const key of HAND_KEYS) {
    const t = spot[key];
    if (!t) continue;
    if (participation(t) > 0) sum += COMBOS[key] ?? 0;
  }
  return sum / TOTAL_COMBOS;
}

/** Solve the narrowing threshold `t` that yields `target` width. */
function solveNarrow(spot: RawSpot, target: number): number {
  let lo = 0;
  let hi = 1 - 1e-9;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (widthAfterNarrow(spot, mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Solve the widening factor `a` that yields `target` width. */
function solveWiden(spot: RawSpot, target: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (widthAfterWiden(spot, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Rescale a raw provider spot to `targetWidth` (combo-weighted) and expand it to
 * the full 169-class `ChartMix`. `targetWidth` NaN means "keep the anchor width".
 */
export function buildChartMix(raw: RawSpot, targetWidth: number): Record<string, ChartMix> {
  const rawWidth = rawSpotWidth(raw);
  const narrow = Number.isFinite(targetWidth) && targetWidth < rawWidth - 1e-9;
  const widen = Number.isFinite(targetWidth) && targetWidth > rawWidth + 1e-9;
  if (widen) {
    const ceiling = maxReachableWidth(raw);
    if (targetWidth > ceiling + 1e-9) {
      throw new Error(
        `buildChartMix: target width ${targetWidth} exceeds the reachable ceiling ${ceiling}; ` +
          'widening keeps p=0 hands folded, so it can never add a class the anchor does not play',
      );
    }
  }
  const t = narrow ? solveNarrow(raw, targetWidth) : 0;
  const a = widen ? solveWiden(raw, targetWidth) : 0;

  const out: Record<string, ChartMix> = {};
  for (const key of HAND_KEYS) {
    const triple = raw[key] ?? ([0, 0, 0] as RawTriple);
    const total = participation(triple);
    if (total <= 0) {
      out[key] = { raise: 0, allin: 0, call: 0, fold: 1, raiseRole: null };
      continue;
    }
    const p = narrow ? clamp01((total - t) / (1 - t)) : widen ? clamp01(total + a * (1 - total)) : total;
    const ratioRaise = triple[0] / total;
    const ratioAllin = triple[1] / total;
    const ratioCall = triple[2] / total;
    const raise = clamp01(p * ratioRaise);
    const allin = clamp01(p * ratioAllin);
    const call = clamp01(p * ratioCall);
    // Re-normalise any residual floating error so every cell sums to exactly 1.
    const used = raise + allin + call;
    const fold = clamp01(1 - used);
    const raises = raise + allin;
    const raiseRole = raises <= 0 ? null : fold <= 1e-6 ? 'value' : 'bluff';
    out[key] = { raise, allin, call, fold, raiseRole };
  }
  return out;
}

interface ChartMeta {
  id: string;
  situation: ChartSituation;
  actor: string | null;
  actorSlot: number;
  behindUnacted: number;
  opener?: string | null;
  openerSlot?: number | null;
  seats: number;
  format: '6max' | '9max' | 'short' | 'hu';
  openSizeBB: number;
}

function sourceFrom(raw: RawChartFile, usage: string): ChartSource {
  return {
    provider: raw.provenance.provider,
    url: raw.provenance.url,
    commit: raw.provenance.commit,
    capturedAt: raw.provenance.capturedAt,
    usage,
  };
}

function spotFrom(meta: ChartMeta): ChartSpot {
  return {
    situation: meta.situation,
    actor: meta.actor,
    actorSlot: meta.actorSlot,
    opener: meta.opener ?? null,
    openerSlot: meta.openerSlot ?? null,
    activeCount: meta.actorSlot + 1,
    behindUnacted: meta.behindUnacted,
  };
}

/** The `B0` (big blind) RFI chart is empty: the BB never opens first in. */
function emptyBbChart(): PreflopChart {
  const mix: Record<string, ChartMix> = {};
  for (const key of HAND_KEYS) mix[key] = { raise: 0, allin: 0, call: 0, fold: 1, raiseRole: null };
  return {
    schema: 'preflop-chart/v1',
    id: 'rfi-b0-bb',
    game: { seats: 0, format: 'short', depthBB: 100, openSizeBB: 2.5 },
    spot: {
      situation: 'unopened',
      actor: 'BB',
      actorSlot: 0,
      opener: null,
      openerSlot: null,
      activeCount: 1,
      behindUnacted: 0,
    },
    source: sourceFrom(FRLA_RFI, 'empty; the BB never opens first in'),
    mix,
  };
}

const chartCache = new Map<string, PreflopChart>();

/**
 * Build (and memoise) the RFI chart for a canonical behind-unacted slot B0..B8.
 * `undefined` for slots outside the range.
 */
export function rfiChartForSlot(slot: number): PreflopChart | undefined {
  const s = Math.trunc(slot);
  if (s < 0 || s > MAX_SLOT) return undefined;
  const cacheKey = `rfi:${s}`;
  const cached = chartCache.get(cacheKey);
  if (cached) return cached;

  let chart: PreflopChart;
  if (s === 0) {
    chart = emptyBbChart();
  } else {
    const sourceSpot = SLOT_TO_SPOT[s] ?? 'UTG-RFI';
    const raw = FRLA_RFI.spots[sourceSpot];
    if (!raw) return undefined;
    const isTail = s > 5;
    const meta: ChartMeta = {
      id: `rfi-b${s}`,
      situation: 'unopened',
      actor: SLOT_ACTOR[s] ?? null,
      actorSlot: s,
      behindUnacted: s,
      seats: isTail ? 9 : 6,
      format: isTail ? '9max' : '6max',
      openSizeBB: 2.5,
    };
    chart = {
      schema: 'preflop-chart/v1',
      id: meta.id,
      game: { seats: meta.seats, format: meta.format, depthBB: 100, openSizeBB: meta.openSizeBB },
      spot: spotFrom(meta),
      source: sourceFrom(
        FRLA_RFI,
        isTail
          ? `9-max tail extrapolation of ${sourceSpot} to W(B)=0.1755*exp(-0.1089*(B-5))`
          : `RFI anchor ${sourceSpot}`,
      ),
      mix: buildChartMix(raw, slotTargetWidth(s)),
    };
  }
  chartCache.set(cacheKey, chart);
  return chart;
}

/** Build (and memoise) the heads-up SB=BTN first-in chart. */
export function huChart(): PreflopChart {
  const cacheKey = 'hu:sb';
  const cached = chartCache.get(cacheKey);
  if (cached) return cached;
  const raw = MHL_HU.spots['SB_OPEN'];
  if (!raw) throw new Error('MHL_HU is missing the SB_OPEN spot');
  const chart: PreflopChart = {
    schema: 'preflop-chart/v1',
    id: 'rfi-hu-sb',
    game: { seats: 2, format: 'hu', depthBB: 100, openSizeBB: 2.5 },
    spot: {
      situation: 'unopened',
      actor: 'SB',
      actorSlot: 1,
      opener: null,
      openerSlot: null,
      activeCount: 2,
      behindUnacted: 1,
    },
    source: sourceFrom(MHL_HU, 'HU SB=BTN first-in: raise 2.5bb / limp / fold'),
    mix: buildChartMix(raw, NaN),
  };
  chartCache.set(cacheKey, chart);
  return chart;
}

export interface AdaptiveChartRequest {
  actorSlot: number;
  headsUp: boolean;
}

/** Pick the adaptive first-in chart for a spot, or null when none applies. */
export function adaptiveChartFor(req: AdaptiveChartRequest): PreflopChart | null {
  if (req.actorSlot <= 0) return null;
  if (req.headsUp) return req.actorSlot === 1 ? huChart() : null;
  return rfiChartForSlot(req.actorSlot) ?? null;
}

/** Convert a chart's per-hand mix into explicit-role `RangeEntry[]`. */
export function chartToRangeEntries(chart: PreflopChart): RangeEntry[] {
  const entries: RangeEntry[] = [];
  for (const key of HAND_KEYS) {
    const m = chart.mix[key];
    if (!m) continue;
    const raise = m.raise + m.allin;
    if (raise > 0) {
      entries.push({ range: key, action: 'raise', weight: raise, role: m.raiseRole ?? 'value' });
    }
    if (m.call > 0) {
      entries.push({ range: key, action: 'call', weight: m.call });
    }
  }
  return entries;
}

/** Combo-weighted total participation of a chart. */
export function chartWidth(chart: PreflopChart): number {
  let sum = 0;
  for (const key of HAND_KEYS) {
    const m = chart.mix[key];
    if (!m) continue;
    sum += (COMBOS[key] ?? 0) * (m.raise + m.allin + m.call);
  }
  return sum / TOTAL_COMBOS;
}

/** Fraction of a chart's participation that is a flat call / limp. */
export function chartLimpShare(chart: PreflopChart): number {
  let part = 0;
  let call = 0;
  for (const key of HAND_KEYS) {
    const m = chart.mix[key];
    if (!m) continue;
    const c = COMBOS[key] ?? 0;
    part += c * (m.raise + m.allin + m.call);
    call += c * m.call;
  }
  return part > 0 ? call / part : 0;
}

/** Validate the `sum == 1 (±1e-6)` invariant; returns the worst deviation. */
export function worstCellDeviation(chart: PreflopChart): number {
  let worst = 0;
  for (const key of HAND_KEYS) {
    const m = chart.mix[key];
    if (!m) continue;
    worst = Math.max(worst, Math.abs(m.raise + m.allin + m.call + m.fold - 1));
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Step 2: facing an open
// ---------------------------------------------------------------------------

/**
 * Opener behind-unacted slot -> FRLA BB-defence spot. The data set has five
 * 6-max anchors: SB (B1), BTN (B2), CO (B3), MP (B4) and UTG (B5). 9-max early
 * slots B6..B8 (UTG1 / MP / UTG) and the degenerate B0 clamp to the tightest
 * anchor (UTG), matching "the earlier the open, the tighter the defence".
 */
const BB_DEFEND_SPOT_BY_OPENER_SLOT: Record<number, string> = {
  1: 'BB-vs-open-SB',
  2: 'BB-vs-open-BTN',
  3: 'BB-vs-open-CO',
  4: 'BB-vs-open-MP',
};

/** The FRLA BB-defence spot key for a canonical opener slot. */
export function bbDefendSpotKey(openerSlot: number): string {
  return BB_DEFEND_SPOT_BY_OPENER_SLOT[Math.trunc(openerSlot)] ?? 'BB-vs-open-UTG';
}

/**
 * How much to tighten a continuing (flat-call / 3-bet) range for each player
 * still to act behind the hero. `0` (the last actor) is the identity; every
 * extra unacted seat narrows the anchor multiplicatively. The factor is always
 * `<= 1`, so the rescaled target never exceeds the anchor width and the
 * narrowing side of `buildChartMix` (call frequency, never a strong hand) is
 * the only branch reached — no widening ceiling can be violated.
 *
 * `0.08` is a **hand-tuned heuristic, NOT fitted to solver data**: the FRLA /
 * MHL subsets have no multiway or squeeze defence anchor, so the slope only
 * needs to be monotone and conservative (`B=0` identity, `B=8` ≈ 0.61×) while
 * the missing data is built. Step 3 must recalibrate it against real
 * multiway / squeeze defence data rather than treat it as a solved value.
 */
export const CONTINUE_WIDTH_SLOPE = 0.08;

export function continueWidthScale(behindUnacted: number): number {
  const b = Math.max(0, Math.min(MAX_SLOT, Math.trunc(behindUnacted)));
  return 1 / (1 + CONTINUE_WIDTH_SLOPE * b);
}

const defendCache = new Map<string, PreflopChart>();

/**
 * Build (and memoise) the BB defence chart against an opener at `openerSlot`.
 * `behindUnacted` only tightens the anchor (it is 0 whenever the BB closes the
 * action, the normal case); the opener slot selects the anchor width, which is
 * itself monotone: SB widest, then BTN, CO, MP, UTG tightest.
 */
export function bbDefendChartFor(openerSlot: number, behindUnacted = 0): PreflopChart {
  const s = canonicalSlot(openerSlot);
  const scale = continueWidthScale(behindUnacted);
  const cacheKey = `bbdefend:${s}:${scale.toFixed(6)}`;
  const cached = defendCache.get(cacheKey);
  if (cached) return cached;

  const key = bbDefendSpotKey(s);
  const raw = FRLA_BB_DEFEND.spots[key];
  if (!raw) throw new Error(`FRLA_BB_DEFEND is missing the "${key}" defence spot`);
  const target = rawSpotWidth(raw) * scale;
  const chart: PreflopChart = {
    schema: 'preflop-chart/v1',
    id: `bbdefend-o${s}`,
    game: { seats: 6, format: '6max', depthBB: 100, openSizeBB: 2.5 },
    spot: {
      situation: 'facingOpen',
      actor: 'BB',
      actorSlot: 0,
      opener: null,
      openerSlot: s,
      activeCount: 2,
      behindUnacted: 0,
    },
    source: sourceFrom(
      FRLA_BB_DEFEND,
      `BB defence vs opener slot B${s} (${key}); target width ${(target * 100).toFixed(2)}%`,
    ),
    mix: buildChartMix(raw, target),
  };
  defendCache.set(cacheKey, chart);
  return chart;
}

/**
 * Scale a legacy `RangeEntry[]` continuing range by `scale` (a fraction of the
 * anchor's frequencies: `0` folds everything, `1` is identity).
 *
 * This deliberately scales only the **call** frequency, leaving the 3-bet value
 * and bluff frequencies intact. The step-1 `buildChartMix` narrow transform
 * keeps every `p = 1` hand untouched, and the cold-call tables are almost
 * entirely `call = 1`, so a threshold shrink has no room to move (the anchor's
 * width *is* its `p = 1` floor) and would silently return the anchor width.
 * Frequency scaling has no such floor, and because the raises are preserved a
 * `role: 'value'` hand still never folds.
 */
export function rescaleRangeMix(entries: RangeEntry[], scale: number): Map<string, CompiledMix> {
  const s = Math.min(1, Math.max(0, scale));
  const anchor = compileRangeMix(entries);
  const out = new Map<string, CompiledMix>();
  for (const [key, m] of anchor) {
    out.set(key, {
      valueRaise: clamp01(m.valueRaise),
      bluffRaise: clamp01(m.bluffRaise),
      marginalRaise: clamp01(m.marginalRaise),
      call: clamp01(m.call * s),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 3: derived charts for the spots with no solver subset
// ---------------------------------------------------------------------------

/**
 * Extra squeeze tightening per caller already in a raised pot, layered on top of
 * `continueWidthScale` for the multiway branch. Like `CONTINUE_WIDTH_SLOPE`,
 * `0.15` is a **hand-tuned heuristic, NOT fitted to solver data** (there is no
 * multiway anchor): it only needs to be monotone and conservative. One caller
 * is `1/1.15 ≈ 0.87×`.
 */
export const MULTIWAY_CALLER_SLOPE = 0.15;

export function multiwayWidthScale(callers: number): number {
  const c = Math.max(0, Math.trunc(Number.isFinite(callers) ? callers : 0));
  return 1 / (1 + MULTIWAY_CALLER_SLOPE * c);
}

/**
 * Hands the derived taper holds at full frequency. Only the two absolute top
 * hands are exempt - they are a raise/stack-off at any table size, so folding a
 * fraction of them would be indefensible. Every other class, including `QQ` and
 * `AK`, scales with the behind-unacted count.
 */
export const DERIVED_ANCHOR_PREMIUM: ReadonlySet<string> = new Set(['AA', 'KK']);

/**
 * Convert explicit-role `RangeEntry[]` anchors into a RawSpot triple map.
 * Overlapping raise/call coverage (the legacy charts overlap freely) is
 * resolved in favour of the raise: the chart carries one fold per class, so the
 * call keeps only the residual `1 - raise` of the shared budget.
 */
export function rangeEntriesToRawSpot(entries: RangeEntry[]): RawSpot {
  const acc: Record<string, [number, number, number]> = {};
  for (const entry of entries) {
    const weight = clamp01(entry.weight ?? 1);
    if (weight <= 0) continue;
    for (const key of parseRange(entry.range).keys) {
      const t = acc[key] ?? [0, 0, 0];
      if (entry.action === 'call') t[2] = Math.min(1, t[2] + weight);
      else t[0] = Math.min(1, t[0] + weight);
      acc[key] = t;
    }
  }
  const out: Record<string, [number, number, number]> = {};
  for (const key of Object.keys(acc)) {
    const t = acc[key]!;
    // The raise wins the shared budget, the call keeps the residual.
    out[key] = [clamp01(t[0]), 0, clamp01(Math.min(t[2], 1 - clamp01(t[0])))];
  }
  return out;
}

/**
 * Taper a derived anchor's participation by `scale`, holding `premium` hands
 * fixed. Unlike `buildChartMix`'s threshold narrowing - which leaves every
 * `p = 1` class untouched and therefore cannot tighten the binary legacy
 * anchors at all - this scales each non-premium class's participation, so the
 * chart width is strictly monotone in `scale` while the premium hands still
 * never fold. A documented heuristic, since the legacy anchors carry no
 * multiway / squeeze frequencies to narrow by threshold.
 */
export function taperRawSpot(
  raw: RawSpot,
  scale: number,
  premium: ReadonlySet<string> = DERIVED_ANCHOR_PREMIUM,
): RawSpot {
  const s = clamp01(scale);
  if (s >= 1) return raw;
  const out: Record<string, RawTriple> = {};
  for (const key of HAND_KEYS) {
    const t = raw[key];
    if (!t) continue;
    const p = participation(t);
    if (p <= 0) continue;
    if (premium.has(key)) {
      out[key] = t;
      continue;
    }
    const p2 = clamp01(p * s);
    if (p2 <= 0) continue;
    const r = p2 / p;
    out[key] = [t[0] * r, t[1] * r, t[2] * r];
  }
  return out;
}

/**
 * The anchor's explicit raise roles, keyed by class. `RangeEntry`'s default
 * role (weight >= 1 is value, fractional is bluff) is mirrored from
 * `compileRangeMix`, so the derived chart preserves the *semantic* role even
 * after the taper makes a value hand mixed raise/fold: a value hand stays a
 * continuation under style discounts, rather than being re-labelled a bluff.
 */
function derivedRaiseRoles(entries: RangeEntry[]): { value: Set<string>; bluff: Set<string> } {
  const value = new Set<string>();
  const bluff = new Set<string>();
  for (const entry of entries) {
    if (entry.action !== 'raise') continue;
    const weight = clamp01(entry.weight ?? 1);
    if (weight <= 0) continue;
    const role = entry.role ?? (weight >= 1 ? 'value' : 'bluff');
    const target = role === 'value' ? value : bluff;
    for (const key of parseRange(entry.range).keys) target.add(key);
  }
  return { value, bluff };
}

export interface DerivedChartSpec {
  id: string;
  situation: ChartSituation;
  actor: string | null;
  actorSlot: number;
  opener: string | null;
  openerSlot: number | null;
  behindUnacted: number;
  activeCount: number;
  seats: number;
  format: '6max' | '9max' | 'short' | 'hu';
  depthBB: number;
  usage: string;
  entries: RangeEntry[];
  scale: number;
  premium?: ReadonlySet<string>;
}

/**
 * Build a `preflop-chart/v1` for a spot with no solver subset by tapering the
 * legacy anchor. The mix still goes through `buildChartMix` (identity target),
 * so the 169-cell sum-to-one normalisation, the explicit `raiseRole` and the
 * `p = 0` handling are the existing mechanism, not a second implementation.
 *
 * The `source` names the in-repo baseline (not a provider export): the anchor is
 * a hand-built approximation, and the taper is an explicit unsourced heuristic.
 */
export function buildDerivedChart(spec: DerivedChartSpec): PreflopChart {
  const raw = rangeEntriesToRawSpot(spec.entries);
  const tapered = taperRawSpot(raw, spec.scale, spec.premium ?? DERIVED_ANCHOR_PREMIUM);
  const roles = derivedRaiseRoles(spec.entries);
  const mix = buildChartMix(tapered, NaN);
  // Preserve the anchor's explicit role on every raising class: `buildChartMix`
  // re-derives it from the (tapered) fold frequency, which would relabel a
  // tapered value raise as a bluff.
  for (const key of HAND_KEYS) {
    const m = mix[key];
    if (!m) continue;
    if (m.raise + m.allin <= 0) {
      m.raiseRole = null;
    } else if (roles.value.has(key)) {
      m.raiseRole = 'value';
    } else if (roles.bluff.has(key)) {
      m.raiseRole = 'bluff';
    }
  }
  return {
    schema: 'preflop-chart/v1',
    id: spec.id,
    game: {
      seats: spec.seats,
      format: spec.format,
      depthBB: spec.depthBB,
      openSizeBB: 2.5,
    },
    spot: {
      situation: spec.situation,
      actor: spec.actor,
      actorSlot: spec.actorSlot,
      opener: spec.opener,
      openerSlot: spec.openerSlot,
      activeCount: spec.activeCount,
      behindUnacted: spec.behindUnacted,
    },
    source: {
      provider: 'rules-v1-baseline',
      url: 'internal://packages/agent-core/src/preflopRanges.ts',
      commit: 'working-tree',
      capturedAt: 'n/a',
      usage: spec.usage,
    },
    mix,
  };
}
