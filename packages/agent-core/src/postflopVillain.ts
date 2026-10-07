import {
  ALL_CARDS,
  HAND_CATEGORY,
  rankOf,
  suitOf,
  type CardId,
} from '@4am/shared';
import { gridFraction, snapOpponentRead } from './betSizing.js';
import type { DecisionView } from './decisionView.js';
import type { VillainCombo, VillainRange } from './equity.js';
import { heroWasAggressor } from './tableContext.js';
import { clamp01 } from './postflopMath.js';
import { lruGet, lruSet } from './postflopCache.js';
import { evaluateHand, type HandEval } from './postflopStrength.js';
import { bucketStrength, handBucket } from './postflopBuckets.js';
import { classifyTexture } from './postflopTexture.js';
import {
  boardFlushInfo,
  FLUSH_TIER,
  flushLayerOf,
  heroFlushBlockFactor,
} from './postflopBlockers.js';
import { DEFAULT_P2, type P2Options } from './postflopP2.js';

/**
 * Conditional (range-weighted) opponent model (a postflop signal).
 *
 * Moved verbatim out of `postflopPolicy.ts`: the P0 villain range model
 * (value-heavy / balanced / bluff-heavy), the per-combo strength tier and model
 * weighting, the board-cached weighted `VillainRange` builder, the observed
 * opponent-model stats, the facing-bet model/range wrappers, and the P0
 * sample/decision-band helpers. Pure and decision-free; the policy orchestrator
 * only reads this layer. Re-exported from `postflopPolicy.ts`.
 */

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
 *
 * Input contract: `hole` is exactly the two distinct cards held by the player
 * and `board` is a legal board (no duplicates, no overlap with `hole`). The
 * in-module caller `villainBaseCombos` always satisfies this. This function is
 * also re-exported through `postflopPolicy.js`, where the `CardId[]` parameter
 * types cannot express "exactly two distinct cards", so the two `??` guards in
 * `strengthTierFromEval` are the deliberate **boundary of that external input
 * contract** - not internal defence. On a well-formed hole/board they are
 * unreachable; do not delete them without moving the contract into the type.
 */
export function villainStrengthTier(
  hole: readonly CardId[],
  board: readonly CardId[],
): number {
  return strengthTierFromEval(evaluateHand(hole, board), hole, board);
}

/** Tier from an already-computed `HandEval` (avoids a second board sweep).
 *  Assumes a well-formed hole/board per `villainStrengthTier`'s input contract;
 *  the two `??` below only absorb an external caller's contract breach. */
function strengthTierFromEval(
  ev: HandEval,
  hole: readonly CardId[],
  board: readonly CardId[],
): number {
  if (ev.category >= HAND_CATEGORY.fullHouse) return 1; // full house / quads / straight flush
  if (ev.category === HAND_CATEGORY.flush) {
    // P1 flush stratification: nut 1.0, second .97, middle .93, low .88.
    // `?? 'low'` is the input-contract boundary (see `villainStrengthTier`): an
    // illegal external hole/board that `evaluateHand` calls a flush but
    // `flushLayerOf` cannot layer. Never reached from `villainBaseCombos`.
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
      // `?? maxBoard` is the input-contract boundary (see `villainStrengthTier`):
      // a legal board always yields two distinct ranks here once a hole card
      // pairs it, so this only absorbs a malformed/short external board.
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
