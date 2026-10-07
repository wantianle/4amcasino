import {
  ALL_CARDS,
  HAND_CATEGORY,
  rankOf,
  suitOf,
  type CardId,
} from '@4am/shared';
import {
  DEFAULT_SIZE_STREET,
  POSTFLOP_SIZE_GRIDS,
  gridFraction,
  nearestStreetSize,
  postflopStreetOf,
  snapOpponentRead,
  streetSupportsOverbet,
  type PostflopStreet,
} from './betSizing.js';
import type { DecisionLegalActions, DecisionView } from './decisionView.js';
import {
  estimateEquity,
  mulberry32,
  type VillainCombo,
  type VillainRange,
} from './equity.js';
import type { PolicyDecision } from './policy.js';
import { deriveRulesSeed } from './rulesSeed.js';
import type { RuleParams } from './ruleStyles.js';
import { normalizeLegalActions } from './legalActions.js';
import { betAmount, guaranteedLegalAction, raiseToAmount } from './actionAdapter.js';
import { bluffToValueRatio, defendProbability, resolveFacingBetPrice } from './potPrice.js';
import {
  deriveTableContext,
  heroInPosition,
  heroWasAggressor,
  postflopActionOrder,
} from './tableContext.js';
import { clamp, clamp01 } from './postflopMath.js';
import { lruGet, lruSet } from './postflopCache.js';
import { bestScore, evaluateHand, type HandEval } from './postflopStrength.js';
import { bucketStrength, handBucket } from './postflopBuckets.js';
import { classifyTexture, type BoardTexture } from './postflopTexture.js';
import {
  boardFlushInfo,
  blockerScore,
  FLUSH_TIER,
  flushLayerOf,
  heroFlushBlockFactor,
  isExposedOverpair,
  madeHandSuppressedByBoard,
} from './postflopBlockers.js';

// Price helpers moved to `potPrice.ts`; re-exported so existing importers keep
// their `postflopPolicy` import path.
export {
  mdf,
  bluffToValueRatio,
  defendProbability,
  resolveFacingBetPrice,
} from './potPrice.js';
export type { FacingBetPrice } from './potPrice.js';

// Table-context helpers moved to `tableContext.ts`; re-exported for existing
// importers (the postflop signal snapshot imports both).
export { heroInPosition, heroWasAggressor } from './tableContext.js';

// Postflop feature layer (hand strength, 24-bucket, texture, flush/blocker)
// moved into dedicated pure modules; re-exported so the historical public
// surface of `postflopPolicy.js` is unchanged.
export { evaluateHand, type HandEval } from './postflopStrength.js';
export { classifyTexture, type BoardTexture } from './postflopTexture.js';
export {
  MADE_BUCKETS,
  DRAW_BUCKETS,
  handBucket,
  bucketStrength,
  bucketAdvantage,
  type MadeBucket,
  type DrawBucket,
  type HandBucket,
} from './postflopBuckets.js';
export {
  dominantFlushSuit,
  flushLayerOf,
  heroFlushExposed,
  isExposedOverpair,
  isOverpair,
  madeHandSuppressedByBoard,
  blockerScore,
  type FlushLayer,
} from './postflopBlockers.js';

/**
 * Rules-v1 postflop engine.
 *
 * A compact, deterministic *heuristic* (no solver / CFR / network / GTO). It is
 * built around four modern concepts, each an intentional approximation:
 *
 *  1. **Conditional range equity vs pot odds** — facing a bet we assign the
 *     bettor a coarse continuing range (value-heavy / balanced / bluff-heavy)
 *     from public information, weight every board-remaining opponent combo by a
 *     heuristic strength tier, and estimate hero equity against that weighted
 *     range. We call when equity clears pot odds by an adaptive sampling-error
 *     band (`facingBetMargin`), fold when it is clearly short, and randomise by
 *     the old `mdf = P/(P+B)` percentile mix inside the band. This is still an
 *     approximation (no range propagation) but no longer a pure frequency
 *     argument against uniform unknown combos.
 *  2. **Flush stratification (P1)** — a made flush is not a flat nuts-weight:
 *     `flushLayerOf` splits it into nut / second / middle / low from the hand's
 *     own same-suit ranks versus every flush still makeable, and the villain
 *     range is weighted by that layer. Hero's own flush holding is folded into
 *     the range as a blocker correction (`heroFlushBlockFactor`): a nut/second
 *     blocker lightens the opponent's flush range, while holding no card of the
 *     suit keeps the flush range at full value and slightly heavier. Only an
 *     **overpair** with no card of that suit (`isExposedOverpair`, i.e.
 *     `isOverpair && heroFlushExposed`) is treated as a bluff-catcher and has
 *     its bet/raise frequency dialled
 *     down; every other made-hand category keeps its normal aggression. Both the
 *     facing-bet value raise and the unopened value bet additionally apply
 *     `madeHandSuppressedByBoard`, a board-aware correction: on a four-flush
 *     board with no card of the suit, on a four-to-a-straight board with no
 *     straight, or with a board-only made hand of value category (`>= 3`:
 *     trips / straight / flush / boat / quads / straight flush built by the
 *     board itself), the made hand is no longer treated as an automatic value
 *     hand (only a real equity edge / the normal check-bluff flow is).
 *  3. **Bet sizing** — per-street grid (`flop 33/75`, `turn 50/75/100/150`,
 *     `river 33/50/75/100/150`, plus all-in); the heuristic picks from texture
 *     (dry/wet, high/low, connected/suited) and SPR / position / range
 *     advantage, then snaps to the street's allowed sizes.
 *  4. **Value:bluff ratio** — approximates bluffs ≈ `f/(1+f)` × value for an
 *     `f`-pot bet.
 *  5. **Blockers** — a hand-built score preferring bluffs that block the
 *     opponent's continuing/nut range and avoiding those that block their folds;
 *     P1 also uses the flush-block factor above inside the facing-a-bet equity.
 *
 * Exported pure helpers (`mdf`, `classifyTexture`, `chooseBetFraction`,
 * `bluffToValueRatio`, `blockerScore`, `handPercentile`, ...) carry the logic
 * and are unit-tested directly. Hand ranking is delegated entirely to the shared
 * evaluator — this module never re-implements poker hand comparison.
 */

// ---------------------------------------------------------------------------
// value-bet / bluff / blocker probabilities (sizing)
// ---------------------------------------------------------------------------

// `mdf` and `bluffToValueRatio` moved to `potPrice.ts` (re-exported above).

/** Probability a value hand fires, from the style's value-bet scale. */
export function valueBetProbability(params: RuleParams, advantage: number): number {
  return clamp01(0.55 + 0.4 * params.valueBetScale + 0.15 * advantage);
}

/** Blocker multiplier in [0.2, 2.2], centred near 1 for a neutral blocker. */
export function blockerFactor(blocker: number): number {
  return clamp(0.4 + 1.6 * clamp01(blocker), 0.2, 2.2);
}

// `defendProbability` moved to `potPrice.ts` (re-exported above).

/**
 * Heuristic bluff bet probability for a bet of `fraction` pot: approximates the
 * MDF-consistent bluff:value ratio `f/(1+f)` times the value-bet probability,
 * scaled by style bluff, blocker, multiway and (bounded) exploit multipliers.
 * Not an equilibrium computation.
 */
export function bluffBetProbability(
  params: RuleParams,
  fraction: number,
  advantage: number,
  blocker: number,
  multiwayMultiplier = 1,
  exploit = 1,
): number {
  return clamp01(
    bluffToValueRatio(fraction) *
      valueBetProbability(params, advantage) *
      params.bluffScale *
      blockerFactor(blocker) *
      multiwayMultiplier *
      exploit,
  );
}


export interface SizingContext {
  spr: number;
  inPosition: boolean;
  rangeAdvantage: number;
  /** Seeded roll used only for the overbet gate. */
  overbetRoll?: number;
  maxOverbetFrequency?: number;
}

/**
 * Pick the bot's own bet size from the **street's** grid.
 *
 *  - wet boards: 75% (50% at low SPR, to avoid bloating with marginal equity);
 *  - dry ace-high / range-advantage boards: 33% range bet;
 *  - dry disadvantaged spots: 50%;
 *  - overbet only on dry, high-SPR, clear-advantage boards and within the
 *    style's `maxOverbetFrequency` — mapped to the top of the street's grid
 *    (150% on turn/river).
 *
 * The flop standard has **no overbet tier**, so `maxOverbetFrequency` is
 * ignored on `street === 'flop'` (see {@link streetSupportsOverbet}); the flop
 * top legal size is 75%.
 *
 * The heuristic picks a raw fraction and snaps it to the nearest point the
 * street actually allows (e.g. a 0.5-pot pick on the flop becomes 0.33), so the
 * returned value is always a legal size for `street`. Turn and river differ by
 * design: turn has no 33% tier.
 */
export function chooseBetFraction(
  texture: BoardTexture,
  ctx: SizingContext,
  street: PostflopStreet = DEFAULT_SIZE_STREET,
): number {
  const grid = POSTFLOP_SIZE_GRIDS[street];
  const overbetFreq = ctx.maxOverbetFrequency ?? 0;
  if (
    streetSupportsOverbet(street) &&
    !texture.wet &&
    ctx.rangeAdvantage >= 0.4 &&
    ctx.spr >= 4 &&
    overbetFreq > 0 &&
    (ctx.overbetRoll ?? 1) < overbetFreq
  ) {
    return grid[grid.length - 1]!;
  }
  let raw: number;
  if (texture.wet) raw = ctx.spr < 2.5 ? 0.5 : 0.75;
  else if (ctx.rangeAdvantage >= 0.3) raw = 0.33;
  else if (ctx.rangeAdvantage <= -0.3) raw = 0.5;
  else raw = texture.aceHigh ? 0.33 : 0.5;
  return nearestStreetSize(raw, grid);
}

// ---------------------------------------------------------------------------
// P2: per-street bet-size grid (single source: ./betSizing.ts)
// ---------------------------------------------------------------------------
//
// The grid data and the read helpers live in `./betSizing.ts` so the policy and
// the frozen baseline fixtures share one definition — a sizing edit cannot
// silently diverge between a policy and its differential baseline. Re-exported
// here for existing importers (`postflopPolicy.POSTFLOP_SIZE_GRID`, etc.).
export {
  POSTFLOP_SIZE_GRID,
  POSTFLOP_SIZE_GRIDS,
  OPPONENT_READ_GRID,
  DEFAULT_SIZE_STREET,
  streetSupportsOverbet,
  gridFraction,
  snapBetFraction,
  snapOpponentRead,
  postflopStreetOf,
} from './betSizing.js';
export type { PostflopSize, PostflopStreet } from './betSizing.js';

/** Heuristic range/nut-advantage score in [-1, 1] (positive = hero favours). */
export function rangeAdvantage(input: {
  heroWasAggressor: boolean;
  inPosition: boolean;
  texture: BoardTexture;
}): number {
  let a = 0;
  if (input.heroWasAggressor) a += 0.4;
  if (input.inPosition) a += 0.2;
  if (input.texture.aceHigh) a += 0.25;
  if (input.texture.lowConnected) a -= 0.3;
  if (!input.heroWasAggressor && !input.inPosition) a -= 0.2;
  return clamp(a, -1, 1);
}

// ---------------------------------------------------------------------------
// hand percentile (empirical CDF vs all *opponent* combos: board + hero removed)
// ---------------------------------------------------------------------------

interface BoardDist {
  /** Sorted scores of every board-remaining two-card combo (includes hero cards). */
  scores: number[];
  /** Per-card sorted scores of the combos containing that card. */
  byCard: Map<CardId, number[]>;
}

const distCache = new Map<string, BoardDist>();

/** All cards not on the board and not in hero's hand. */
function unknownDeck(hole: readonly CardId[], board: readonly CardId[]): CardId[] {
  const known = new Set<CardId>([...board, ...hole]);
  return ALL_CARDS.filter((card) => !known.has(card));
}

/** Number of opponent combos in the prior: C(52 - board - hole, 2). */
export function unknownComboCount(hole: readonly CardId[], board: readonly CardId[]): number {
  const n = unknownDeck(hole, board).length;
  return (n * (n - 1)) / 2;
}

/** Number of entries `< target` (strict) or `<= target` in a sorted list. */
function countLess(list: readonly number[], target: number, strict: boolean): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = list[mid]!;
    const less = strict ? v < target : v <= target;
    if (less) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Board-level combo distribution, computed once per board (all C(49,2) combos
 * of the board-remaining deck, hero's cards included). Hero-card exclusion for a
 * specific hand is then handled analytically in `handPercentile`, so the
 * expensive `evaluate7` sweep is NOT repeated per decision.
 */
function boardDist(board: readonly CardId[]): BoardDist {
  const key = [...board].sort((a, b) => a - b).join(',');
  const cached = lruGet(distCache, key);
  if (cached) return cached;
  const boardSet = new Set(board);
  const deck = ALL_CARDS.filter((card) => !boardSet.has(card));
  const scores: number[] = [];
  const byCard = new Map<CardId, number[]>();
  for (const card of deck) byCard.set(card, []);
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const a = deck[i]!;
      const b = deck[j]!;
      const s = bestScore([a, b, ...board]);
      scores.push(s);
      byCard.get(a)!.push(s);
      byCard.get(b)!.push(s);
    }
  }
  scores.sort((a, b) => a - b);
  for (const list of byCard.values()) list.sort((a, b) => a - b);
  const dist = { scores, byCard };
  lruSet(distCache, key, dist);
  return dist;
}

/**
 * Approximate percentile of our hand versus a uniform prior over all opponent
 * combos with **both** board and hero's cards removed (C(47,2) = 1081 on a
 * flop). Ties are counted with their mid-rank so the value is unbiased under
 * equal scores. Derived from the per-board distribution by subtracting the
 * combos that use either of hero's cards (their shared combo added back once).
 */
export function handPercentile(hole: readonly CardId[], board: readonly CardId[]): number {
  if (hole.length < 2 || board.length < 3) return 0.5;
  const [a, b] = hole;
  if (a === undefined || b === undefined) return 0.5;
  const total = unknownComboCount(hole, board);
  if (total <= 0) return 0.5;
  const dist = boardDist(board);
  const s = bestScore([...hole, ...board]);

  const aList = dist.byCard.get(a) ?? [];
  const bList = dist.byCard.get(b) ?? [];
  const less = countLess(dist.scores, s, true) - countLess(aList, s, true) - countLess(bList, s, true);
  const equalOrLess =
    countLess(dist.scores, s, false) -
    countLess(aList, s, false) -
    countLess(bList, s, false) +
    1; // the {a,b} combo equals our score and is counted in both card lists
  const equal = equalOrLess - less;
  return (less + 0.5 * equal) / total;
}

// ---------------------------------------------------------------------------
// P0: conditional (range-weighted) opponent model for facing-a-bet decisions
// ---------------------------------------------------------------------------

/**
 * P0 replaces the old "uniform unknown-combo percentile + MDF short-circuit"
 * defence with a **conditional range equity vs pot odds** decision:
 *
 *  1. classify the bettor's likely continuing range into one of three coarse
 *     tiers - value-heavy / balanced / bluff-heavy - from public information
 *     only (bet size relative to the pot, all-in, board wetness, whether hero
 *     was the preflop aggressor, and observed VPIP/PFR/postflop aggression);
 *  2. weight every board-remaining opponent combo by a heuristic hand-strength
 *     tier under that model, and estimate hero equity against that weighted
 *     range (rather than against uniform unknown combos);
 *  3. call when `equity > potOdds + margin`, fold when
 *     `equity < potOdds - margin`, and only inside the band fall back to the
 *     former MDF/percentile randomisation. `margin` is the estimator's own
 *     `~2` standard errors, so a spot is only treated as "clear" when the
 *     observed edge exceeds sampling noise.
 *
 * This is intentionally a small, explainable approximation: it rebuilds the
 * weighted range from public information on every facing-a-bet decision and does
 * not propagate a range across streets (the experimental `rangePropagation`
 * capability was evaluated and deleted outright - see {@link P2Options}). The
 * weighted range is applied to every still-active opponent (a multiway
 * simplification); when a tiny range cannot fill every opponent without
 * replacement, `estimateEquity` fills the overflow uniformly and reports
 * `uniformFallbacks`.
 */
export type VillainRangeModel = 'value-heavy' | 'balanced' | 'bluff-heavy';

/**
 * Floor of the equity/pot-odds decision band. The band itself is adaptive (see
 * `facingBetMargin`), this only keeps a small tolerance for a near-certain
 * estimate where the standard error vanishes.
 */
export const P0_FACING_BET_MARGIN = 0.05;

/** Confidence multiplier applied to the estimator's standard error for the band. */
export const P0_BET_CONFIDENCE = 1.96;

/**
 * Monte-Carlo samples for one heads-up facing-a-bet equity estimate. At
 * `p = 0.5` the standard error is `sqrt(0.25/128) = 4.4%`, so a 95% decision
 * band (`1.96 * SE`) is ~8.7% — an edge that large is a real edge, not seed
 * noise. The band is still derived from the actual sample count via
 * `facingBetMargin` rather than being a fixed cutoff, so no decision claims a
 * sharper boundary than its samples support.
 */
export const P0_EQUITY_SAMPLES = 128;

/**
 * Samples for the multiway facing-a-bet estimate. Multiway already applies one
 * heuristic continuing range to every opponent (a documented simplification),
 * so it spends half the heads-up budget to bound the worst-case per-decision
 * cost; its error-matched band is correspondingly wider.
 */
export const P0_MULTIWAY_EQUITY_SAMPLES = 64;

/** Sample budget for a facing-bet decision against `opponents` active hands. */
export function facingBetSamples(opponents: number): number {
  return opponents <= 1 ? P0_EQUITY_SAMPLES : P0_MULTIWAY_EQUITY_SAMPLES;
}

/**
 * Half-width of the equity/pot-odds decision band for an observed `equity`:
 * `max(P0_FACING_BET_MARGIN, 1.96 * sqrt(e(1-e)/samples))`. Near `e = 0.5` this
 * is ~0.123 at 64 samples; it narrows as the estimate approaches 0/1. Comparing
 * the point estimate against `requiredEquity ± facingBetMargin(equity)` means
 * the "clear call / clear fold" zones account for the estimator's own sampling
 * error, and spots inside the band deliberately mix via the MDF/percentile
 * fallback instead of pretending the point estimate is exact.
 */
export function facingBetMargin(equity: number, samples = P0_EQUITY_SAMPLES): number {
  const e = clamp01(equity);
  const se = Math.sqrt(Math.max(0, (e * (1 - e)) / Math.max(1, samples)));
  return Math.max(P0_FACING_BET_MARGIN, P0_BET_CONFIDENCE * se);
}

// `FacingBetPrice` / `resolveFacingBetPrice` moved to `potPrice.ts` and
// re-exported above.

export interface VillainModelInput {
  /** The bettor's bet as a fraction of the pot *before* the bet (1 = pot). */
  betFraction: number;
  /** Any still-active opponent is all-in. */
  allIn: boolean;
  /** Hero made the last preflop aggressive action. */
  heroWasAggressor: boolean;
  /** Board is flush/straight heavy (polarises a betting range). */
  wet: boolean;
  /** Observed opponents' average VPIP / PFR / postflop aggression, if known. */
  opponentVpip?: number;
  opponentPfr?: number;
  opponentAggression?: number;
}

/**
 * Map public bet/opponent information onto one of the three coarse range tiers.
 *
 * Bet size drives the baseline: all-in / large are value-leaning, small bets
 * bluff-leaning, medium sits in the (explicitly defined) neutral zone that maps
 * to `balanced`. Wet boards and hero holding the preflop aggression shade the
 * baseline a further half-step toward bluff-heavy, because both make a bet less
 * likely to be pure value.
 *
 * Opponent type then overrides the size read, because it changes what a bet of
 * that size means:
 *  - a **maniac** (loose, aggressive) bets/shoves a wide, bluff-heavy range, so
 *    any bet is `bluff-heavy`;
 *  - a **station** (loose, passive preflop) or a **nit** (very tight) rarely
 *    bluffs, so any bet is `value-heavy`.
 * With no usable read ("normal" opponent) the size/texture baseline stands.
 */
export function chooseVillainModel(
  input: VillainModelInput,
  sizeGrid: boolean = DEFAULT_P2.sizeGrid,
): VillainRangeModel {
  let score = 0;
  if (input.allIn) {
    score += 2;
  } else {
    // P2: read the size on the discrete grid, so a weird size (0.42, 0.62, 3.0)
    // is translated to its nearest abstract size instead of being read as an
    // exact continuous value. `sizeGrid` is on by default since 2026-10-06; with
    // it off the raw thresholds are used. The read uses the **global** opponent
    // grid ({@link OPPONENT_READ_GRID}), not our per-street action standard: the
    // same observed size must mean the same thing on every street.
    const size = sizeGrid ? gridFraction(snapOpponentRead(input.betFraction)) : input.betFraction;
    if (size >= 1) score += 1.5;
    else if (size <= 0.4) score -= 1;
    else if (size <= 0.6) score -= 0.3;
  }
  if (input.wet) score -= 0.5;
  if (input.heroWasAggressor) score -= 0.5;

  const { opponentVpip: vpip, opponentPfr: pfr, opponentAggression: aggression } = input;
  const maniac = vpip !== undefined && vpip > 0.55 && (aggression ?? 0) > 0.5 && (pfr ?? 1) > 0.25;
  const station = vpip !== undefined && vpip > 0.45 && (pfr ?? 1) < 0.18;
  const nit = vpip !== undefined && vpip < 0.22;
  if (maniac) {
    // A maniac's bet is mostly bluffs regardless of size; cap the score into the
    // bluff-heavy band.
    score = Math.min(score, -1.5);
  } else if (station || nit) {
    // A station/nit bets for value; cap the score into the value-heavy band.
    score = Math.max(score, 1.5);
  }

  if (score >= 1) return 'value-heavy';
  if (score <= -1) return 'bluff-heavy';
  return 'balanced';
}

/**
 * Heuristic strength tier in [0, 1] for one opponent combo on the current board:
 * made hands dominate, strong draws sit in the middle, air at the bottom. Purely
 * a ranking aid for range weighting - never used to compare hero's hand.
 *
 * P1: a made flush is no longer a flat 1.0 - it is stratified into nut / second
 * / middle / low from the combo's own same-suit ranks (see `flushLayerOf`), so a
 * value-heavy continuing range is weighted by flush percentile rather than
 * treating every flush as equally strong.
 */
export function villainStrengthTier(
  hole: readonly CardId[],
  board: readonly CardId[],
): number {
  return strengthTierFromEval(evaluateHand(hole, board), hole, board);
}

/** Tier from an already-computed `HandEval` (avoids a second board sweep). */
function strengthTierFromEval(
  ev: HandEval,
  hole: readonly CardId[],
  board: readonly CardId[],
): number {
  if (ev.category >= HAND_CATEGORY.fullHouse) return 1; // full house / quads / straight flush
  if (ev.category === HAND_CATEGORY.flush) {
    // P1 flush stratification: nut 1.0, second .97, middle .93, low .88.
    return FLUSH_TIER[flushLayerOf(hole, board) ?? 'low'];
  }
  // On a four-flush board every non-flush made hand loses to any flush, so it
  // cannot be part of a value-heavy continuing range.
  const boardSuits = [0, 0, 0, 0];
  for (const card of board) boardSuits[suitOf(card)] = boardSuits[suitOf(card)]! + 1;
  if (Math.max(0, ...boardSuits) >= 4) return 0.35;
  if (ev.category === HAND_CATEGORY.straight) return 0.95; // straight
  if (ev.category === HAND_CATEGORY.trips) return 0.9; // three of a kind / set
  if (ev.category === HAND_CATEGORY.twoPair) return 0.8; // two pair
  if (ev.category === HAND_CATEGORY.pair) {
    const boardRanks = board.map(rankOf);
    const maxBoard = boardRanks.length ? Math.max(...boardRanks) : -1;
    const pairedWithBoard = hole.find((card) => boardRanks.includes(rankOf(card)));
    if (pairedWithBoard !== undefined) {
      // Top/middle pair vs a weak pair: compare the paired rank to the second
      // highest board rank (a coarse "top pair or better" split).
      const sorted = [...new Set(boardRanks)].sort((a, b) => b - a);
      const second = sorted[1] ?? maxBoard;
      return rankOf(pairedWithBoard) >= second ? 0.62 : 0.4;
    }
    const pocket = rankOf(hole[0]!) === rankOf(hole[1]!);
    if (pocket) return rankOf(hole[0]!) > maxBoard ? 0.55 : 0.25; // overpair / underpair
    return 0.3; // playing the board's pair
  }
  if (ev.flushDraw || ev.straightDraw >= 2) return 0.4; // strong draw
  if (ev.straightDraw === 1) return 0.25;
  if (ev.overcards >= 1) return 0.15;
  return 0.05; // air
}

/** Weight a combo's strength tier under a range model. */
export function villainModelWeight(tier: number, model: VillainRangeModel): number {
  const t = clamp01(tier);
  switch (model) {
    case 'value-heavy':
      // Steep: on a made-hand board the bettor's range is close to their
      // strongest tier, so draws/air are all but removed (a value-heavy range
      // still keeps a trace of everything, hence the floor).
      return 0.01 + t * t * t * t * t;
    case 'bluff-heavy':
      return 1 - 0.55 * t; // air up-weighted, value still present but discounted
    case 'balanced':
    default:
      return 0.25 + 0.75 * t;
  }
}

interface VillainBaseCombo {
  a: CardId;
  b: CardId;
  tier: number;
  /** P1: combo makes a flush on this board (gets hero's flush-block factor). */
  isFlush: boolean;
}

const villainTierCache = new Map<string, VillainBaseCombo[]>();

/**
 * Board-keyed cache of every board-remaining combo's strength tier. The expensive
 * `evaluateHand` sweep runs once per board, not once per decision; per-decision
 * hero-card exclusion and model weights are then cheap O(combos) passes.
 */
function villainBaseCombos(board: readonly CardId[]): VillainBaseCombo[] {
  const key = [...board].sort((a, b) => a - b).join(',');
  const cached = lruGet(villainTierCache, key);
  if (cached) return cached;
  const boardSet = new Set(board);
  const deck = ALL_CARDS.filter((card) => !boardSet.has(card));
  const combos: VillainBaseCombo[] = [];
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const a = deck[i]!;
      const b = deck[j]!;
      const ev = evaluateHand([a, b], board);
      combos.push({
        a,
        b,
        tier: strengthTierFromEval(ev, [a, b], board),
        isFlush: ev.category === HAND_CATEGORY.flush,
      });
    }
  }
  lruSet(villainTierCache, key, combos);
  return combos;
}

/**
 * Weighted villain combos for the board, excluding hero's own cards. Returned as
 * an explicit `VillainRange` so `estimateEquity` samples it without re-running
 * any hand evaluation.
 *
 * P1: hero's flush holding is folded in as an equity correction - every villain
 * flush combo is scaled by `heroFlushBlockFactor`, so a nut/second-nut blocker
 * lightens the opponent's flush range (hero defends more) while holding no card
 * of the suit makes it relatively heavier (hero's unprotected made hands are
 * discounted). When hero holds **no** card of the board's flush suit, every
 * villain flush is additionally pinned to `villainModelWeight(1, ...)` instead
 * of its P1 layer weight. That is a deliberately **conservative prior specific
 * to the no-suit hero** - it is NOT a general statement that all flushes are
 * nuts, and it must not be read as one; it exists only so an unprotected made
 * hand is evaluated against a flush-saturated range. This is a heuristic range
 * tilt, not a solved conditional range.
 */
export function buildVillainRange(
  hole: readonly CardId[],
  board: readonly CardId[],
  model: VillainRangeModel,
  opts: Readonly<Pick<P2Options, 'buckets'>> = DEFAULT_P2,
): VillainCombo[] {
  const heroSet = new Set(hole);
  const info = boardFlushInfo(board);
  const exposed = info ? !hole.some((card) => suitOf(card) === info.suit) : false;
  const flushFactor = info && !exposed ? heroFlushBlockFactor(hole, info) : 1;
  const exposedFlushFactor = info && exposed ? heroFlushBlockFactor(hole, info) : 1;
  const out: VillainCombo[] = [];
  for (const combo of villainBaseCombos(board)) {
    if (heroSet.has(combo.a) || heroSet.has(combo.b)) continue;
    let weight = villainModelWeight(combo.tier, model);
    if (combo.isFlush && info) {
      // Hero holds no card of the suit: do not apply the flush stratification
      // (which would under-weight the many low flushes and inflate hero's
      // unprotected made hands); keep the flush range at full value and tilt it
      // slightly heavier, the blocker correction against hero.
      weight = exposed
        ? villainModelWeight(1, model) * exposedFlushFactor
        : weight * flushFactor;
    }
    // P2 buckets (on by default since 2026-10-06): tilt by the 24-bucket
    // strength, so the range/nut-advantage read has one more independent signal
    // than the ad-hoc P0/P1 tier. A documented heuristic, not a solved range.
    if (opts.buckets) {
      weight *= 0.5 + bucketStrength(handBucket([combo.a, combo.b], board));
    }
    out.push({ cards: [combo.a, combo.b], weight });
  }
  return out;
}

// ---------------------------------------------------------------------------
// P2: feature toggles
// ---------------------------------------------------------------------------

/**
 * The P2 behaviour switches that remain after the 2026-10-06 prune. Each is
 * independently injectable so a caller (or a test) can A/B or enable one without
 * touching the other.
 *
 * History: the product briefly ran P2 all-on (commit `5e8566a`); the first A/B
 * eval (`docs/plans/2026-10-06-bot-ab-eval-results.md`) judged all-four-on
 * `worse` than the all-off baseline in its narrow rig (3-handed, `always-call`
 * anchor, mirror strategy): `p2:all` cluster CI `[-85.8, -17.1]`, so it was
 * reverted to all-off on 2026-10-06. The fairer follow-up
 * (`docs/plans/2026-10-06-bot-ab-eval-v2-fair.md`, real tendentious opponents
 * TAG/station/LAG + `always-call`) then found `rangePropagation` significantly
 * harmful under two opponents (TAG -43.7 bb/100, station -55.3) and `shrinkage`
 * harmful under station (-32.0), with consistent sign; **both switches were
 * therefore deleted outright** (capability permanently off, no toggle). Only
 * `sizeGrid` / `buckets` survive.
 *
 * **Not byte-for-byte identical to the pre-P2 baseline**: this file also carries
 * an always-on `evaluateHand` fix (exclude straight draws with no hero-only rank
 * contribution; clear the draw flag at `category >= 4`), which applies to hero
 * and villain-combo evaluation regardless of the switches. See
 * `docs/plans/postflop-p2-report.md` §3 for the exact scope.
 */
export interface P2Options {
  /** Snap an observed bet size to the discrete `POSTFLOP_SIZE_GRID`. */
  sizeGrid: boolean;
  /** Tilt villain combo weights by their 24-bucket strength. */
  buckets: boolean;
}

/**
 * Default P2 configuration. **`sizeGrid` / `buckets` are ON by default.**
 *
 * ⚠️ Risk, recorded explicitly: the fair v2 A/B
 * (`docs/plans/2026-10-06-bot-ab-eval-v2-fair.md`) measured a positive mean for
 * `buckets` across all four opponents (+3.8 / +6.6 / +20.1 / +4.5 bb/100) but
 * **every interval was inconclusive** (sample too small - this is NOT proof it
 * helps), and `sizeGrid` is ≈0 against betting opponents and exactly 0 against
 * non-betting ones. **Defaulting them on is a product decision, not a
 * statistical conclusion — do not describe it as "validated".** Set
 * `FOURAM_P2_ALL_OFF=1` for the all-off fallback.
 *
 * History: this constant was all-off after the 2026-10-06 revert (commit
 * `5e8566a` had briefly made it all-on, and
 * `docs/plans/2026-10-06-bot-ab-eval-results.md` judged all-four-on `worse` in
 * its narrow rig). `rangePropagation` / `shrinkage` were subsequently deleted
 * (see {@link P2Options}); the two survivors become product-default on.
 *
 * `Object.freeze` + `Readonly<P2Options>` keep the default immutable: a runtime
 * write (`DEFAULT_P2.sizeGrid = false`) neither compiles nor takes effect, so
 * the default parameters that read this constant cannot be silently flipped.
 * Callers that want a switch off must pass their own explicit `p2` option.
 */
export const DEFAULT_P2: Readonly<P2Options> = Object.freeze({
  sizeGrid: true,
  buckets: true,
});

/**
 * Frozen explicit all-off configuration: the pre-P2 decision path
 * (`sizeGrid` / `buckets` both `false`). With {@link DEFAULT_P2} now defaulting
 * both on this is the named **kill-switch / A/B control**, and it is no longer
 * identical to the default. It is kept as a named constant because callers
 * (server env `FOURAM_P2_ALL_OFF`, the eval harness) and tests reference it
 * explicitly, so the one-import rollback cannot drift from the `DEFAULT_P2`
 * shape. Pass it as `new PostflopPolicy({ ..., p2: P2_ALL_OFF })`.
 */
export const P2_ALL_OFF: Readonly<P2Options> = Object.freeze({
  sizeGrid: false,
  buckets: false,
});

/**
 * Observed average VPIP / PFR / postflop aggression of the active opponents,
 * using the raw ratios of every opponent with at least 10 observed hands
 * (`sampleHands < 10` is discarded). This is the permanent post-prune behaviour:
 * the former `shrinkage` alternative (Beta posterior mean) was deleted together
 * with its switch, so a small sample can no longer contribute. An all-short-
 * sample table yields `{}` (a neutral, no-read result).
 */
export function opponentModelStats(view: DecisionView): {
  vpip?: number;
  pfr?: number;
  aggression?: number;
} {
  const bySeat = new Map(view.sessionMemory.opponents.map((o) => [o.seat, o]));
  let vpip = 0;
  let pfr = 0;
  let aggression = 0;
  let n = 0;
  for (const o of view.opponents) {
    if (o.folded) continue;
    const stats = bySeat.get(o.seat);
    if (!stats) continue;
    if (stats.sampleHands < 10) continue;
    vpip += stats.vpipHands / stats.sampleHands;
    pfr += stats.pfrHands / stats.sampleHands;
    aggression +=
      stats.postflopBetsRaises / (stats.postflopBetsRaises + stats.postflopCalls + 1);
    n++;
  }
  if (n === 0) return {};
  return { vpip: vpip / n, pfr: pfr / n, aggression: aggression / n };
}

/**
 * The coarse range model the P0/P2 decision assigns to the current bettor,
 * derived only from the public `DecisionView`. Exported so tests can reproduce
 * the decision's own equity estimate exactly.
 */
export function facingVillainModel(
  view: DecisionView,
  potBefore: number,
  call: number,
  opts: Readonly<P2Options> = DEFAULT_P2,
): VillainRangeModel {
  const board = view.hand?.board ?? [];
  const texture = classifyTexture(board);
  const activeOpponents = view.opponents.filter((o) => !o.folded);
  const stats = opponentModelStats(view);
  return chooseVillainModel(
    {
      betFraction: potBefore > 0 ? call / potBefore : 1,
      allIn: activeOpponents.some((o) => o.allIn),
      heroWasAggressor: heroWasAggressor(view),
      wet: texture.wet,
      opponentVpip: stats.vpip,
      opponentPfr: stats.pfr,
      opponentAggression: stats.aggression,
    },
    opts.sizeGrid,
  );
}

/** Weighted range the P0/P2 decision samples against for this view. */
export function facingVillainRange(
  view: DecisionView,
  hole: readonly CardId[],
  potBefore: number,
  call: number,
  opts: Readonly<P2Options> = DEFAULT_P2,
): VillainRange {
  const board = view.hand?.board ?? [];
  return { combos: buildVillainRange(hole, board, facingVillainModel(view, potBefore, call, opts), opts) };
}

// ---------------------------------------------------------------------------
// positional / aggression helpers
// ---------------------------------------------------------------------------

// `heroWasAggressor` / `heroInPosition` moved to `tableContext.ts`, where
// `heroInPosition` uses the postflop action order (`postflopActionOrder`) rather
// than the preflop dealing order, so heads-up IP/OOP stays correct. Both are
// re-exported above for existing importers.

/**
 * Seat of the aggressor hero is responding to: the **last** preflop bet/raise in
 * the observed history, or `null` when none is visible. For an opening decision
 * that is the opener; for a 4-bet it is the 3-bettor — i.e. the reference
 * opponent for preflop IP/OOP sizing.
 */
export function lastPreflopRaiserSeat(view: DecisionView): number | null {
  const pre = view.actionHistory.filter((a) => a.street === 'preflop');
  for (let i = pre.length - 1; i >= 0; i--) {
    const a = pre[i]!;
    if (a.action.type === 'bet' || a.action.type === 'raise') return a.seat;
  }
  return null;
}

/**
 * True when hero acts **after** the given opponent in **postflop** order, i.e.
 * hero is in position relative to that opponent. This is the position that
 * matters for the preflop 3-bet / 4-bet sizing standard (smaller in position,
 * larger out of position, to compensate for playing later streets OOP). Unlike
 * {@link heroInPosition} (which asks whether hero is last to act among *all*
 * active players), this compares hero to one specific opponent, so a third
 * active player behind hero does not flip the answer, and an all-in third party
 * is irrelevant.
 *
 * Uses {@link postflopActionOrder}, **not** the preflop dealing order: heads-up
 * they are opposites (button/SB first preflop, last postflop), so reusing the
 * dealing-order index would mark the BB as in position. Unknown hero /
 * opponent, or an opponent not present in the order, falls back to `false`
 * (treated as out of position, the larger sizing) rather than guessing — a
 * conservative, risk-averse default, not a claim that hero *is* OOP.
 */
export function heroIsIPToOpener(view: DecisionView, opponentSeat: number | null): boolean {
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  if (mySeat === null || opponentSeat === null || opponentSeat === mySeat) return false;
  const order = postflopActionOrder(view);
  const myIdx = order.indexOf(mySeat);
  const oppIdx = order.indexOf(opponentSeat);
  if (myIdx < 0 || oppIdx < 0) return false;
  return myIdx > oppIdx;
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

// `heroWasAggressor` / `heroInPosition` moved to `tableContext.ts` and
// re-exported above.

export interface PostflopOptions {
  params: RuleParams;
  /** Base seed; the per-decision seed is `deriveRulesSeed(seed, view)`. */
  seed?: number;
  /** P2 behaviour switches; omitted fields keep `DEFAULT_P2`. */
  p2?: Partial<P2Options>;
}

/** A legitimate, always-legal fallback action. */
function onlyLegal(la: DecisionLegalActions, reason: string): PolicyDecision {
  return { action: guaranteedLegalAction(la), reason };
}

export class PostflopPolicy {
  readonly name = 'rules-v1-postflop';
  private readonly params: RuleParams;
  private readonly seed: number;
  private readonly p2: P2Options;

  constructor(options: PostflopOptions) {
    this.params = options.params;
    this.seed = options.seed ?? 0x9e3779b9;
    this.p2 = { ...DEFAULT_P2, ...options.p2 };
  }

  decide(view: DecisionView): PolicyDecision {
    const raw = view.legalActions;
    if (!raw) throw new Error(`${this.name} asked to act out of turn`);
    const la = normalizeLegalActions(raw);
    const hole = view.hand?.myCards ?? [];
    const board = view.hand?.board ?? [];
    if (!view.hand || view.hand.street === 'preflop' || hole.length < 2 || board.length < 3) {
      return onlyLegal(la, 'rules-v1 postflop: no card context');
    }

    const rng = mulberry32(deriveRulesSeed(this.seed, view));
    const ev = evaluateHand(hole, board);
    const percentile = handPercentile(hole, board);
    const texture = classifyTexture(board);
    const inPosition = heroInPosition(view);
    const adv = rangeAdvantage({
      heroWasAggressor: heroWasAggressor(view),
      inPosition,
      texture,
    });
    const spr = this.spr(view);
    const active = Math.max(1, view.opponents.filter((o) => !o.folded).length);
    const call = la.callAmount;

    if (la.canCheck) {
      return this.decideUnopened(view, la, hole, board, ev, percentile, texture, adv, spr, rng);
    }
    return this.decideFacingBet(
      view,
      la,
      hole,
      board,
      ev,
      percentile,
      texture,
      adv,
      spr,
      active,
      call,
      rng,
    );
  }

  private spr(view: DecisionView): number {
    return deriveTableContext(view).spr;
  }

  private effectiveStackBB(view: DecisionView): number {
    return deriveTableContext(view).effectiveStackBB;
  }

  private exploitMultiplier(view: DecisionView): number {
    const bySeat = new Map(view.sessionMemory.opponents.map((o) => [o.seat, o]));
    let vpip = 0;
    let pfr = 0;
    let n = 0;
    for (const o of view.opponents) {
      if (o.folded) continue;
      const stats = bySeat.get(o.seat);
      if (!stats) continue;
      // Raw rates from opponents with a usable sample. The former `shrinkage`
      // branch (posterior-mean read + confidence-scaled exploit) was deleted
      // with its switch, so this cutoff is the permanent behaviour.
      if (stats.sampleHands < 10) continue;
      vpip += stats.vpipHands / stats.sampleHands;
      pfr += stats.pfrHands / stats.sampleHands;
      n++;
    }
    if (n === 0) return 1;
    const avgVpip = vpip / n;
    const avgPfr = pfr / n;
    let m = 1;
    if (avgVpip > 0.45 && avgPfr < 0.18) m *= 0.6; // station: bluff less
    else if (avgVpip < 0.22) m *= 1.25; // nit: bluff more
    return clamp(m, 0.4, 1.4);
  }

  private aggressionMultiplier(view: DecisionView, blocker: number, active: number): number {
    return clamp(
      this.params.bluffScale *
        blockerFactor(blocker) *
        this.exploitMultiplier(view) *
        (active >= 2 ? this.params.multiwayBluffScale : 1),
      0,
      4,
    );
  }

  private decideUnopened(
    view: DecisionView,
    la: DecisionLegalActions,
    hole: readonly CardId[],
    board: readonly CardId[],
    ev: HandEval,
    percentile: number,
    texture: BoardTexture,
    adv: number,
    spr: number,
    rng: () => number,
  ): PolicyDecision {
    const blocker = blockerScore(hole, board);
    const draw = ev.flushDraw || ev.straightDraw >= 1;
    // Board-aware: a made hand whose raw category is nullified by the board
    // (a four-flush / four-straight runout, or a board-only made hand of value
    // category - trips / straight / flush / boat / quads) is not an automatic
    // value bet - only a live hand is. See `madeHandSuppressedByBoard`.
    const boardSuppressed = madeHandSuppressedByBoard(hole, board, ev, texture);
    const value = !boardSuppressed && (ev.category >= HAND_CATEGORY.trips || percentile >= 0.8);
    const bluffCandidate = !value && percentile < 0.6 && (draw || blocker >= 0.4);
    // P1: an **overpair** with no card of the board's flush suit is a
    // bluff-catcher against a flush-heavy continuing range, so it bets less
    // often. The discount is deliberately scoped to exposed overpairs only -
    // sets, two pair, straights and strong draws keep their normal frequency.
    const exposedOverpair = isExposedOverpair(hole, board, ev);

    if (la.canBet) {
      const sizingCtx: SizingContext = {
        spr,
        inPosition: heroInPosition(view),
        rangeAdvantage: adv,
        overbetRoll: rng(),
        maxOverbetFrequency: this.params.maxOverbetFrequency,
      };
      if (value && rng() < valueBetProbability(this.params, adv) * (exposedOverpair ? 0.6 : 1)) {
        return this.bet(view, la, texture, sizingCtx, `rules-v1 postflop value (pct ${percentile.toFixed(2)}${exposedOverpair ? ', no-suit overpair' : ''})`);
      }
      if (bluffCandidate) {
        const fraction = chooseBetFraction(
          texture,
          sizingCtx,
          postflopStreetOf(view.hand?.street),
        );
        const active = Math.max(1, view.opponents.filter((o) => !o.folded).length);
        const prob = bluffBetProbability(
          this.params,
          fraction,
          adv,
          blocker,
          active >= 2 ? this.params.multiwayBluffScale : 1,
          this.exploitMultiplier(view),
        );
        if (rng() < prob) {
          return this.bet(view, la, texture, sizingCtx, `rules-v1 postflop bluff (blocker ${blocker.toFixed(2)})`);
        }
      }
    }
    return { action: { type: 'check' }, reason: `rules-v1 postflop check (pct ${percentile.toFixed(2)})` };
  }

  private decideFacingBet(
    view: DecisionView,
    la: DecisionLegalActions,
    hole: readonly CardId[],
    board: readonly CardId[],
    ev: HandEval,
    percentile: number,
    texture: BoardTexture,
    adv: number,
    spr: number,
    active: number,
    call: number,
    rng: () => number,
  ): PolicyDecision {
    // Resolve the price from the snapshot (pure, unit-tested): a malformed
    // field, a mismatched call amount or a pot below the call is never clamped
    // into a fold. `price.trusted` gates the equity comparison; an untrusted
    // snapshot takes the conservative MDF/percentile path below.
    const price = resolveFacingBetPrice(view.potOdds, call);
    const potBefore = price.potBefore;
    const requiredEquity = price.requiredEquity;
    const priceTrusted = price.trusted;
    const required = price.requiredMdf;

    // P0: equity against a heuristic continuing range (value/balanced/bluff
    // weighted), compared with the price. A non-finite estimate fails closed to
    // zero equity rather than a neutral 0.5 that would invite a call. A
    // malformed view (hole/board overlap) or an estimator error falls back to
    // the neutral `requiredEquity` - the policy must never throw just because a
    // snapshot was inconsistent.
    const samples = facingBetSamples(active);
    let equity = requiredEquity;
    try {
      const knownValid = new Set([...hole, ...board]).size === hole.length + board.length;
      if (knownValid) {
        const estimate = estimateEquity({
          hole,
          board,
          opponents: active,
          samples,
          seed: deriveRulesSeed(this.seed, view),
          villainRange: facingVillainRange(view, hole, potBefore, call, this.p2),
        });
        equity = Number.isFinite(estimate.equity) ? clamp01(estimate.equity) : 0;
      }
    } catch {
      equity = requiredEquity;
    }

    let defend: boolean;
    if (!priceTrusted) {
      // Conservative neutral path: the price mirror is unusable, so never fold
      // solely on its account. Defend by hand percentile against the MDF of the
      // authoritative pot/call price (or a neutral 0.5 when the pot is bad too).
      defend = rng() < defendProbability(percentile, required);
    } else {
      // The band is the estimator's own ~2 standard errors, so a decision only
      // counts as clear when the observed edge exceeds sampling noise; inside
      // the band the former MDF/percentile mix still sets the frequency.
      const margin = facingBetMargin(equity, samples);
      if (equity > requiredEquity + margin) {
        defend = true;
      } else if (equity < requiredEquity - margin) {
        defend = false;
      } else {
        defend = rng() < defendProbability(percentile, required);
      }
    }
    if (!defend) {
      return {
        action: { type: 'fold' },
        reason: `rules-v1 postflop fold (equity ${equity.toFixed(2)} < pot odds ${requiredEquity.toFixed(2)}, pct ${percentile.toFixed(2)})`,
      };
    }

    const sizingCtx: SizingContext = {
      spr,
      inPosition: heroInPosition(view),
      rangeAdvantage: adv,
      overbetRoll: rng(),
      maxOverbetFrequency: this.params.maxOverbetFrequency,
    };

    // `equity` is already available; a clear equity edge also counts as value.
    // P1: only an **overpair** with no card of the flush suit is a bluff-catcher
    // on a suited board - it is held back from value raising (a much tighter
    // equity gate and a lower raise frequency).
    // Board-aware: a made hand whose raw category is nullified by a completed
    // board draw (`madeHandSuppressedByBoard`) is likewise held back - its
    // category / percentile proxies do not count as value, only a real equity
    // edge does. This stops a four-flush set (or a four-straight set / two pair)
    // from auto-raising when every continuing hand beats it.
    const exposedOverpair = isExposedOverpair(hole, board, ev);
    const boardSuppressed = madeHandSuppressedByBoard(hole, board, ev, texture);
    const strong =
      (!boardSuppressed && (ev.category >= HAND_CATEGORY.trips || percentile >= 0.85)) ||
      equity >= (exposedOverpair ? 0.86 : 0.8);
    if (strong && la.canRaise && rng() < (exposedOverpair ? 0.2 : 0.6)) {
      return this.raise(view, la, texture, sizingCtx, `rules-v1 postflop value raise (pct ${percentile.toFixed(2)}, eq ${equity.toFixed(2)}${exposedOverpair ? ', no-suit overpair' : ''})`);
    }

    const blocker = blockerScore(hole, board);
    const draw = ev.flushDraw || ev.straightDraw >= 1;
    if (
      la.canRaise &&
      (draw || blocker >= 0.5) &&
      rng() < 0.35 * (exposedOverpair ? 0.5 : 1) * this.aggressionMultiplier(view, blocker, active)
    ) {
      return this.raise(view, la, texture, sizingCtx, `rules-v1 postflop semibluff raise (blocker ${blocker.toFixed(2)})`);
    }
    return {
      action: { type: 'call' },
      reason: `rules-v1 postflop call (equity ${equity.toFixed(2)} vs pot odds ${requiredEquity.toFixed(2)}, pct ${percentile.toFixed(2)})`,
    };
  }

  private bet(
    view: DecisionView,
    la: DecisionLegalActions,
    texture: BoardTexture,
    ctx: SizingContext,
    reason: string,
  ): { action: { type: 'bet'; amount: number }; reason: string } {
    // Short-stack override: below 20BB an unopened bet is a deliberate shove to
    // the stack, taking precedence over every standard grid size below. It
    // matches the raise() convention (and the shared engine's "bet up to stack"
    // rule), so a short stack never gets a "standard size, capped" instead.
    if (this.effectiveStackBB(view) < 20) {
      return { action: { type: 'bet', amount: la.maxRaiseTo }, reason: `${reason} all-in` };
    }
    const pot = view.potOdds?.pot ?? 0;
    const fraction = chooseBetFraction(texture, ctx, postflopStreetOf(view.hand?.street));
    const amount = betAmount({
      pot,
      fraction,
      minRaiseTo: la.minRaiseTo,
      maxRaiseTo: la.maxRaiseTo,
    });
    return { action: { type: 'bet', amount }, reason };
  }

  private raise(
    view: DecisionView,
    la: DecisionLegalActions,
    texture: BoardTexture,
    ctx: SizingContext,
    reason: string,
  ): { action: { type: 'raise'; amount: number }; reason: string } {
    // Short-stack override: see bet(); a sub-20BB raise is a deliberate shove.
    if (this.effectiveStackBB(view) < 20) {
      return { action: { type: 'raise', amount: la.maxRaiseTo }, reason: `${reason} all-in` };
    }
    const pot = view.potOdds?.pot ?? 0;
    const currentBet = view.hand?.currentBet ?? 0;
    const fraction = chooseBetFraction(texture, ctx, postflopStreetOf(view.hand?.street));
    const amount = raiseToAmount({
      pot,
      currentBet,
      fraction,
      minRaiseTo: la.minRaiseTo,
      maxRaiseTo: la.maxRaiseTo,
    });
    return { action: { type: 'raise', amount }, reason };
  }
}
