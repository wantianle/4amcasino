import type { RuleParams } from './ruleStyles.js';
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
  RFI_MARGINAL,
  RFI_RANGES,
  type PositionGroup,
} from './preflopRanges.js';
import {
  adaptiveChartFor,
  bbDefendChartFor,
  buildDerivedChart,
  chartToRangeEntries,
  chartWidth,
  continueWidthScale,
  HAND_KEYS,
  multiwayWidthScale,
  rescaleRangeMix,
  rfiChartForSlot,
  rustVsOpenRaiseTable,
  type PreflopChart,
  type RustVsOpenRaiseTable,
} from './preflopCharts/index.js';
import {
  compileRangeMix,
  type CompiledMix,
  type RangeEntry,
} from './rangeParser.js';
import { positionBehindCount, type PreflopContext } from './preflopContext.js';
import { clamp01 } from './preflopMath.js';

/**
 * Preflop range construction: build the compiled raise/call mix for a
 * `PreflopContext`, from the legacy position tables, the headcount-adaptive
 * charts, and the Rust vs-open provider.
 *
 * This is the single home of preflop range building, so a canonical range
 * provider can be extracted from here without touching the frequency layer.
 */

/**
 * Compiled mixes are pure functions of the charts, so memoise them per
 * spot/position/opener instead of re-parsing the range strings on every
 * decision. The returned maps are read-only to callers.
 */
const mixCache = new Map<string, Map<string, CompiledMix>>();

/**
 * The legacy position-named baseline charts. No longer the default: the
 * headcount-adaptive path is the default engine (see `ADAPTIVE_PREFLOP_DEFAULT`)
 * and this is the explicit fallback when adaptive is switched off
 * (`params.adaptivePreflop === false`) or the spot/headcount cannot be trusted.
 */
function buildLegacyMix(ctx: PreflopContext): Map<string, CompiledMix> {
  let mix: Map<string, CompiledMix>;
  switch (ctx.spot) {
    case 'unopened': {
      const base = RFI_RANGES[ctx.position];
      const marginal = RFI_MARGINAL[ctx.position];
      const entries: RangeEntry[] = [];
      if (base) entries.push({ range: base, action: 'raise', weight: 1, role: 'value' });
      if (marginal) entries.push({ range: marginal, action: 'raise', weight: 1, role: 'marginal' });
      mix = compileRangeMix(entries);
      break;
    }
    case 'limped':
      mix = compileRangeMix([
        { range: ISO_RANGES[ctx.positionGroup], action: 'raise', weight: 1, role: 'value' },
      ]);
      break;
    case 'facing4BetPlus':
      mix = compileRangeMix(FACING_4BET_PLUS);
      break;
    case 'facing3Bet':
      mix = compileRangeMix([...FACING_3BET_4BET, ...FACING_3BET_CALL]);
      break;
    case 'facing3BetCold':
      mix = compileRangeMix(COLD_3BET_COLD);
      break;
    default: {
      // facingOpen / facingOpenMultiway: 3-bet/call versus a single open.
      const openerGroup: PositionGroup = ctx.openerGroup ?? 'EP'; // conservative when unknown
      const entries: RangeEntry[] = [
        { range: COLD_3BET_VALUE[openerGroup], action: 'raise', weight: 1, role: 'value' },
        {
          range: COLD_3BET_BLUFF[openerGroup],
          action: 'raise',
          weight: COLD_3BET_BLUFF_WEIGHT,
          role: 'bluff',
        },
      ];
      if (ctx.positionGroup === 'BB') {
        entries.push(...BB_DEFEND[openerGroup]);
      } else {
        entries.push({ range: CALL_VS_OPEN[ctx.positionGroup], action: 'call', weight: 1 });
      }
      mix = compileRangeMix(entries);
      break;
    }
  }
  return mix;
}

/**
 * True when the adaptive headcount charts may serve this decision: the flag is
 * on, the history is complete, the hero is the live acting seat (active and
 * `toAct`), and the seat states give a trustworthy current-round behind-unacted
 * count. Anything else falls back to the legacy tables — missing history is
 * never read as "nobody acted", and a snapshot that is not actually the hero's
 * live decision is never served.
 *
 * Per-spot gates:
 *  - `unopened`: slot B1..B8 (B0 = BB never opens); HU uses the HU chart at B1.
 *  - `facingOpen`: non-HU, a known opener slot B1..B5, and the server's
 *    `needToAct` (`needToActTracked`) with a non-empty list that contains the
 *    hero — the defensive widths depend on who still owes an action after a
 *    raise, which the historical "acted at some point" set cannot express.
 *  - `limped`: non-HU. No raise has happened yet, so a reopening is impossible
 *    this round and the fallback pending inference is trustworthy.
 *  - `facingOpenMultiway` / `facing3Bet` / `facing3BetCold` / `facing4BetPlus`:
 *    non-HU and a raise is on the table, so the current-round `needToAct`
 *    contract is required exactly as for `facingOpen`.
 *
 * Heads-up facing a raise (or any later street of the auction) stays on the
 * legacy tables: the FRLA subset is 6-max and the step-1 contract pinned HU
 * BB-facing-raise to legacy. HU limped pots are pinned to legacy for the same
 * reason (no HU limp-iso anchor exists); see the `limped` branch below.
 */
export function adaptivePreflopAvailable(ctx: PreflopContext, params: RuleParams): boolean {
  if (!params.adaptivePreflop) return false;
  if (!ctx.historyComplete || !ctx.headcountReliable) return false;
  if (!(ctx.dealtCount >= 2 && ctx.dealtCount <= 9)) return false;
  if (!Number.isFinite(ctx.behindUnacted)) return false;
  // Every adaptive branch models a live decision by the hero. A stale or
  // malformed snapshot can list the hero in `needToAct` while the hero is
  // folded / all-in / sitting out, or while the public turn belongs to another
  // seat; such a view is not a hero decision and must fall back to legacy.
  if (!ctx.heroActive) return false;
  if (!ctx.heroToAct) return false;

  switch (ctx.spot) {
    case 'unopened':
      // HU first-in is the SB=BTN chart; B0 (BB) never opens first in.
      if (ctx.headsUp) return ctx.actorSlot === 1;
      return ctx.actorSlot >= 1 && ctx.actorSlot <= 8;

    case 'facingOpen':
      if (ctx.headsUp) return false;
      if (ctx.openerSlot === null || ctx.openerSlot < 1 || ctx.openerSlot > 5) return false;
      // Without `needToAct`, a raise reopening the round is invisible and
      // `behindUnacted` can undercount — never serve the defensive charts then.
      if (!ctx.needToActTracked) return false;
      // A tracked snapshot is necessary but not sufficient. The adaptive premise
      // is "the hero still owes this round and there are live players behind".
      // An empty list is a closed/mis-timed snapshot, and a list without the
      // hero is not a live decision for them; either way `behindUnacted` would
      // not measure the hero's own pending action, so fall back to legacy.
      if (!ctx.needToActSeats || ctx.needToActSeats.length === 0) return false;
      if (!ctx.needToActSeats.includes(ctx.heroSeat)) return false;
      return ctx.actorSlot >= 0 && ctx.actorSlot <= 8;

    case 'limped':
      // No raise yet, so the round cannot have reopened: the historical
      // "active and not acted" inference behind `behindUnacted` is exact.
      //
      // HU limped pots deliberately stay on the legacy tables. A heads-up BB
      // facing a SB limp is *not* the same decision as a multiway isolation
      // raise: there is no ISO_RANGES equivalent for HU (the legacy ISO tables
      // are position-group based, non-HU), and the FRLA/HU solver subsets have
      // no HU limp-iso anchor to derive from. Serving the multiway
      // `ISO_RANGES` here would import a wider, non-HU range into a 2-handed
      // pot with no evidence. The step-1 contract already pinned HU
      // BB-facing-raise to legacy; HU limped is pinned for the same reason.
      // Switching it to adaptive would require a dedicated HU limp-iso anchor,
      // not a gate tweak.
      if (ctx.headsUp) return false;
      return ctx.actorSlot >= 0 && ctx.actorSlot <= 8;

    case 'facingOpenMultiway':
    case 'facing3Bet':
    case 'facing3BetCold':
    case 'facing4BetPlus':
      // A raise is on the table: the round can reopen, so the current-round
      // pending list is required, non-empty, and must name the hero.
      if (ctx.headsUp) return false;
      if (!ctx.needToActTracked) return false;
      if (!ctx.needToActSeats || ctx.needToActSeats.length === 0) return false;
      if (!ctx.needToActSeats.includes(ctx.heroSeat)) return false;
      return ctx.actorSlot >= 0 && ctx.actorSlot <= 8;

    default:
      return false;
  }
}

/**
 * Non-BB cold 3-bet / cold-call versus a single open.
 *
 * The **call** side is always the legacy anchor: `CALL_VS_OPEN` narrowed by
 * `behindUnacted` (`rescaleRangeMix` scales only the call frequency, so value /
 * bluff raises are preserved). The **raise** side comes from the Rust vs-open
 * provider where the hero / opener seats map exactly onto the 6-max export
 * (see `preflopCharts/rustVsOpen.ts`); elsewhere the legacy `COLD_3BET_*`
 * anchor is used unchanged.
 *
 * Merge (`mergeRustVsOpenRaise`): a mapped class's Rust raise becomes the
 * `valueRaise` verbatim — it is **not** re-weighted by
 * `COLD_3BET_BLUFF_WEIGHT` or `CONTINUE_WIDTH_SLOPE` — the legacy bluff is
 * dropped, and the legacy call keeps `legacyContinue - rustRaise`, so a hand the
 * legacy anchor never folds (AA, QQ, ...) cannot fold merely because Rust raises
 * it less than 100%. A class the export leaves `na`/absent falls back to the
 * legacy raise untouched (three-state). Malformed input from an external caller
 * follows the same rule: a non-finite raise is unknown (legacy untouched),
 * while a finite out-of-range one is clamped to `[0, 1]`.
 */
export function mergeRustVsOpenRaise(
  legacy: ReadonlyMap<string, CompiledMix>,
  rust: ReadonlyMap<string, number | null>,
): Map<string, CompiledMix> {
  const out = new Map<string, CompiledMix>();
  const keys = new Set<string>([...legacy.keys(), ...rust.keys()]);
  for (const key of keys) {
    const l = legacy.get(key);
    const legacyValue = l?.valueRaise ?? 0;
    const legacyBluff = l?.bluffRaise ?? 0;
    const legacyCall = l?.call ?? 0;
    const r = rust.get(key);
    // Three-state contract, extended to malformed input. `undefined`/`null`
    // mean "no Rust data"; a non-finite value (`NaN`/`Infinity`) can only reach
    // here from a hand-built external map (the provider maps them to `null`),
    // and is treated the same way: unknown -> the legacy raise is the whole
    // story. Reading it as a known "do not raise" would let a corrupt map
    // silently delete a legacy bluff / flat call.
    if (r === undefined || r === null || !Number.isFinite(r)) {
      // No Rust data for this class: the legacy raise is the whole story.
      if (!l) continue;
      out.set(key, {
        valueRaise: legacyValue,
        bluffRaise: legacyBluff,
        marginalRaise: 0,
        call: legacyCall,
      });
      continue;
    }
    // Rust carries the exact raise; the legacy anchor still decides how often
    // the class continues at all. The Rust raise consumes that continuation
    // budget first, so a hand the legacy table never folds (legacyContinue == 1)
    // cannot fold here.
    //
    // `mergeRustVsOpenRaise` is part of the exported policy surface, so a
    // caller can hand it a raw map that bypasses `normalizeRustTriple`. A
    // finite out-of-range value is clamped here rather than trusted, so
    // `raise + call <= 1` holds for every class no matter the entry point.
    const raise = clamp01(r);
    const legacyContinue = clamp01(legacyValue + legacyBluff + legacyCall);
    out.set(key, {
      valueRaise: raise,
      bluffRaise: 0,
      marginalRaise: 0,
      call: clamp01(legacyContinue - raise),
    });
  }
  return out;
}

/** The legacy non-BB continuing anchor, narrowed by the headcount. */
function buildColdLegacyAnchor(ctx: PreflopContext): Map<string, CompiledMix> {
  const openerGroup: PositionGroup = ctx.openerGroup ?? 'EP';
  const entries: RangeEntry[] = [
    { range: COLD_3BET_VALUE[openerGroup], action: 'raise', weight: 1, role: 'value' },
    {
      range: COLD_3BET_BLUFF[openerGroup],
      action: 'raise',
      weight: COLD_3BET_BLUFF_WEIGHT,
      role: 'bluff',
    },
    // The BB branch is handled separately, so this is always a non-BB group.
    { range: CALL_VS_OPEN[ctx.positionGroup], action: 'call', weight: 1 },
  ];
  return rescaleRangeMix(entries, continueWidthScale(ctx.behindUnacted));
}

/** The Rust raise table for a context, or null when the seats do not map. */
function rustRaiseForContext(ctx: PreflopContext): RustVsOpenRaiseTable | null {
  if (ctx.opener === null) return null;
  return rustVsOpenRaiseTable(
    positionBehindCount(ctx.position, ctx.dealtCount),
    positionBehindCount(ctx.opener, ctx.dealtCount),
  );
}

function buildColdAdaptiveMix(ctx: PreflopContext): Map<string, CompiledMix> {
  const legacy = buildColdLegacyAnchor(ctx);
  const rust = rustRaiseForContext(ctx);
  if (!rust) return legacy;
  return mergeRustVsOpenRaise(legacy, rust.raise);
}

/** Anchor for a derived (no-solver-subset) adaptive spot. */
interface DerivedAnchor {
  situation: 'unopened' | 'facingOpen' | 'facing3Bet';
  actor: string | null;
  entries: RangeEntry[];
  usage: string;
}

/**
 * Map the remaining preflop spots onto their legacy anchor. These spots have no
 * solver subset, so the anchor is the hand-built rules-v1 table and
 * `behindUnacted` tapers it (see `buildDerivedChart`). Mixed raises keep their
 * explicit role: the value/bluff split of `COLD_3BET_*` and `FACING_3BET_*` is
 * preserved, and only the non-premium participation shrinks.
 */
function derivedAnchorFor(ctx: PreflopContext): DerivedAnchor | null {
  const openerGroup: PositionGroup = ctx.openerGroup ?? 'EP';
  switch (ctx.spot) {
    case 'limped':
      return {
        situation: 'unopened',
        actor: ctx.position,
        entries: [
          { range: ISO_RANGES[ctx.positionGroup], action: 'raise', weight: 1, role: 'value' },
        ],
        usage: `ISO_RANGES.${ctx.positionGroup}`,
      };
    case 'facingOpenMultiway': {
      const entries: RangeEntry[] = [];
      if (ctx.positionGroup === 'BB') {
        entries.push(...BB_DEFEND[openerGroup]);
      } else {
        entries.push(
          { range: COLD_3BET_VALUE[openerGroup], action: 'raise', weight: 1, role: 'value' },
          {
            range: COLD_3BET_BLUFF[openerGroup],
            action: 'raise',
            weight: COLD_3BET_BLUFF_WEIGHT,
            role: 'bluff',
          },
          { range: CALL_VS_OPEN[ctx.positionGroup], action: 'call', weight: 1 },
        );
      }
      return {
        situation: 'facingOpen',
        actor: ctx.position,
        entries,
        usage:
          ctx.positionGroup === 'BB'
            ? `BB_DEFEND.${openerGroup} (multiway)`
            : `COLD_3BET_*.${openerGroup} + CALL_VS_OPEN.${ctx.positionGroup} (multiway)`,
      };
    }
    case 'facing3Bet':
      return {
        situation: 'facing3Bet',
        actor: ctx.position,
        entries: [...FACING_3BET_4BET, ...FACING_3BET_CALL],
        usage: 'FACING_3BET_4BET + FACING_3BET_CALL',
      };
    case 'facing3BetCold':
      return {
        situation: 'facing3Bet',
        actor: ctx.position,
        entries: COLD_3BET_COLD,
        usage: 'COLD_3BET_COLD',
      };
    case 'facing4BetPlus':
      return {
        situation: 'facing3Bet',
        actor: ctx.position,
        entries: FACING_4BET_PLUS,
        usage: 'FACING_4BET_PLUS',
      };
    default:
      return null;
  }
}

/**
 * Build the derived adaptive mix for a remaining spot. Width tapers with
 * `behindUnacted` (`continueWidthScale`), plus an extra documented caller
 * squeeze factor in the multiway pot. The chart is a real `preflop-chart/v1`
 * (169 classes, sum 1, explicit roles); the compiled mix is then fed to the
 * unchanged style / short-stack pipeline.
 */
function buildDerivedAdaptiveMix(ctx: PreflopContext): Map<string, CompiledMix> | null {
  const anchor = derivedAnchorFor(ctx);
  if (!anchor) return null;
  const scale =
    ctx.spot === 'facingOpenMultiway'
      ? continueWidthScale(ctx.behindUnacted) * multiwayWidthScale(ctx.callers)
      : continueWidthScale(ctx.behindUnacted);
  const chart = buildDerivedChart({
    id: `derived-${ctx.spot}-${ctx.position}-b${ctx.actorSlot}`,
    situation: anchor.situation,
    actor: anchor.actor,
    actorSlot: ctx.actorSlot,
    opener: ctx.opener,
    openerSlot: ctx.openerSlot,
    behindUnacted: ctx.behindUnacted,
    activeCount: ctx.activeCount,
    seats: ctx.dealtCount,
    format: ctx.dealtCount <= 2 ? 'hu' : ctx.dealtCount <= 6 ? '6max' : '9max',
    depthBB: Math.round(ctx.stackBB),
    usage: anchor.usage,
    entries: anchor.entries,
    scale,
  });
  return compileRangeMix(chartToRangeEntries(chart));
}

/**
 * Adaptive RFI entries with an explicit `marginal` edge layer, so the style
 * presets differ on the adaptive default exactly as they do on the legacy
 * tables.
 *
 * The adaptive RFI chart alone cannot carry the gradient: `buildChartMix`'s
 * threshold narrowing leaves every `p = 1` class untouched, so the 9-max tail
 * (B6..B8) — a narrowing of the UTG anchor — keeps only a sliver of mixed
 * (raise/fold) cells (B8 ≈ 0.14pt). Tagging just those as marginal would leave
 * the four presets within ~0.1pt of each other, which is the bug this fixes.
 *
 * So the edge layer is taken from the slot's **anchor** — the UTG anchor for the
 * 9-max tail, the chart itself for B1..B5 — where the solver's mixed raises
 * exist in full. It is scaled by the slot's headcount ratio
 * (`chartWidth / anchorWidth <= 1`) so `B6 > B7 > B8` stays true, and compiled
 * with role `marginal`: `effectiveFrequencies` opens it at `preflopScale - 1`,
 * i.e. `tight-aggressive` (scale 1) folds it, `loose-aggressive` (1.5) opens
 * half, `calling-station` (1.15) and `constrained-random` (1.1) a tenth or so.
 *
 * The weight is the anchor's own raise frequency times the headcount ratio, so
 * a marginal open is `raise * (preflopScale - 1) <= raise <= 1`: it never
 * exceeds the frequency the source anchor gave the class, never invents a class
 * the anchor does not play, and therefore never widens past the source. The
 * premium core is untouched (`value` raises keep their full frequency).
 */
function adaptiveRfiEntries(chart: PreflopChart, ctx: PreflopContext): RangeEntry[] {
  const entries: RangeEntry[] = [];
  // Core: every style opens the chart's pure (`value`) raises and its flat
  // calls. The mixed cells are handled as the edge layer below instead.
  for (const key of HAND_KEYS) {
    const m = chart.mix[key];
    if (!m) continue;
    const raise = m.raise + m.allin;
    if (raise > 0 && m.raiseRole === 'value') {
      entries.push({ range: key, action: 'raise', weight: raise, role: 'value' });
    }
    if (m.call > 0) entries.push({ range: key, action: 'call', weight: m.call });
  }
  // Edge: the anchor's mixed raises, scaled to this slot's headcount. For
  // B1..B5 the anchor is the chart itself (identity, ratio 1); for the 9-max
  // tail it is B5, the UTG anchor the tail extrapolates from.
  const tail = ctx.actorSlot > 5;
  const anchor = tail ? rfiChartForSlot(5) : chart;
  if (anchor) {
    const ratio = tail ? Math.min(1, chartWidth(chart) / chartWidth(anchor)) : 1;
    for (const key of HAND_KEYS) {
      const m = anchor.mix[key];
      if (!m || m.raiseRole !== 'bluff') continue;
      const raise = m.raise + m.allin;
      if (raise <= 0) continue;
      entries.push({ range: key, action: 'raise', weight: raise * ratio, role: 'marginal' });
    }
  }
  return entries;
}

function buildAdaptiveMix(ctx: PreflopContext): Map<string, CompiledMix> | null {
  if (ctx.spot === 'facingOpen') {
    if (ctx.positionGroup === 'BB') {
      const chart = bbDefendChartFor(ctx.openerSlot ?? 0, ctx.behindUnacted);
      return compileRangeMix(chartToRangeEntries(chart));
    }
    return buildColdAdaptiveMix(ctx);
  }
  if (ctx.spot === 'unopened') {
    const chart = adaptiveChartFor({ actorSlot: ctx.actorSlot, headsUp: ctx.headsUp });
    if (!chart) return null;
    // HU stays on the literal chart split: it is a single MHL-anchored spot
    // (`HU.SB_OPEN`, ~87% open with a large limp share) that must not drift from
    // its source. The multiway RFI path carries the explicit marginal layer.
    if (ctx.headsUp) return compileRangeMix(chartToRangeEntries(chart));
    return compileRangeMix(adaptiveRfiEntries(chart, ctx));
  }
  return buildDerivedAdaptiveMix(ctx);
}

/**
 * Cache key for a compiled preflop mix. It carries every input that can change
 * the result across decisions: the headcount slot, the auction shape, the depth
 * band, and — crucially — the **final route** the context resolves to.
 *
 * The route, not the raw `adaptivePreflop` flag, is what must be encoded: the
 * flag alone says adaptive is *allowed*, while `adaptivePreflopAvailable` also
 * folds in `historyComplete` / `headcountReliable` / `spot` / `dealtCount` /
 * `actorSlot`. Two contexts that differ only in, say, `historyComplete` resolve
 * to different mixes (adaptive vs legacy) but would share a flag-only key — the
 * first one to populate `mixCache` would then poison the other, breaking the
 * "any failure falls back to the legacy tables" guarantee. Exported so tests can
 * pin that two contexts which must not share do not.
 */
export function preflopMixCacheKey(ctx: PreflopContext, params: RuleParams): string {
  const openerKey =
    ctx.spot === 'unopened' || ctx.spot === 'limped' ? '' : (ctx.openerGroup ?? 'EP');
  const route = adaptivePreflopAvailable(ctx, params) ? 'adaptive' : 'legacy';
  return [
    ctx.spot,
    ctx.position,
    // The opener's *group* is too coarse for the Rust vs-open mapping: MP and
    // LJ share the `MP` group and the sixMax slot 4, yet map to different Rust
    // seats (behind 6 -> unmapped, behind 5 -> UTG). The position name keeps
    // those two contexts from poisoning each other's cached mix.
    openerKey,
    ctx.opener ?? 'n',
    ctx.dealtCount,
    ctx.actorSlot,
    ctx.openerSlot ?? 'n',
    ctx.raises,
    ctx.callers,
    Math.round(ctx.stackBB),
    route,
  ].join('|');
}

/**
 * Resolve the compiled mix for `ctx`. `params.adaptivePreflop` defaults to on,
 * so with a trustworthy headcount the adaptive charts serve every covered spot;
 * a spot/headcount the adaptive path cannot trust — or an explicit
 * `adaptivePreflop:false` kill-switch — falls back to the legacy position tables
 * unchanged.
 */
export function buildMix(ctx: PreflopContext, params: RuleParams): Map<string, CompiledMix> {
  const cacheKey = preflopMixCacheKey(ctx, params);
  const cached = mixCache.get(cacheKey);
  if (cached) return cached;

  let mix: Map<string, CompiledMix> | null = null;
  if (adaptivePreflopAvailable(ctx, params)) mix = buildAdaptiveMix(ctx);
  if (!mix) mix = buildLegacyMix(ctx);
  mixCache.set(cacheKey, mix);
  return mix;
}
