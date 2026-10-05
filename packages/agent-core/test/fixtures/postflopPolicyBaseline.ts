// Generated from packages/agent-core/src/postflopPolicy.ts at HEAD f4a5904 (P0/P1
// baseline) via `git show f4a5904:packages/agent-core/src/postflopPolicy.ts`. Only
// three normalisations were applied: relative imports redirected to ../../src, the
// class renamed to BaselinePostflopPolicy, and this header comment added. The
// decision logic body is byte-for-byte the f4a5904 engine; it exists so a test can
// run "current policy with all P2 switches off" against the true baseline per input.
// DO NOT EDIT BY HAND - regenerate from git if the baseline ever changes.

import {
  ALL_CARDS,
  evaluate5,
  evaluate7,
  handCategory,
  rankOf,
  suitOf,
  type CardId,
} from '@4am/shared';
import type { DecisionLegalActions, DecisionPotOdds, DecisionView } from '../../src/decisionView.js';
import {
  estimateEquity,
  mulberry32,
  type VillainCombo,
  type VillainRange,
} from '../../src/equity.js';
import type { PolicyDecision } from '../../src/policy.js';
import { seatsInDealingOrder } from '../../src/preflopPolicy.js';
import { deriveRulesSeed } from '../../src/rulesSeed.js';
import type { RuleParams } from '../../src/ruleStyles.js';

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
 *     **overpair** with no card of that suit (`isOverpair && heroFlushExposed`)
 *     is treated as a bluff-catcher and has its bet/raise frequency dialled
 *     down; every other made-hand category keeps its normal aggression.
 *  3. **Bet sizing** — `33% / 50% / 75% / overbet` chosen heuristically from
 *     board texture (dry/wet, high/low, connected/suited) and SPR / position /
 *     range advantage.
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

const clamp = (x: number, lo: number, hi: number): number =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
const clamp01 = (x: number): number => clamp(x, 0, 1);

/** Bound for the board-keyed caches (dist + villain tiers). */
const BOARD_CACHE_LIMIT = 256;

/** LRU read: return and refresh recency on a hit. */
function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key) as V;
  cache.delete(key); // re-insert at the MRU end
  cache.set(key, value);
  return value;
}

/** LRU write: insert as MRU and evict the single oldest entry on overflow. */
function lruSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > BOARD_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// hand strength / evaluation
// ---------------------------------------------------------------------------

export interface HandEval {
  /** Shared `handCategory(score)` value: 0 high card .. 8 straight flush. */
  category: number;
  /**
   * Best-hand score from the shared evaluator (`evaluate5`/`evaluate7`); the
   * single source of truth for hand ranking. Higher is better and ties compare
   * exactly (wheel, straight flush, flush/straight kickers included).
   */
  score: number;
  flushDraw: boolean;
  /** 0 none, 1 gutshot, 2 open-ended / double-gutter (draw heuristic only). */
  straightDraw: number;
  overcards: number;
}

/** Best 5-card score from 5..7 cards, using the shared evaluators. */
function bestScore(cards: readonly CardId[]): number {
  if (cards.length < 5) return 0;
  if (cards.length === 5) return evaluate5([...cards]);
  if (cards.length === 7) return evaluate7([...cards]);
  // 6 cards: best 5 of 6.
  let best = 0;
  for (let skip = 0; skip < cards.length; skip++) {
    const five = cards.filter((_, i) => i !== skip);
    const s = evaluate5(five);
    if (s > best) best = s;
  }
  return best;
}

/** Straight presence in a 13-rank count array, wheel (A2345) included. */
function hasStraight(counts: number[]): boolean {
  const p = counts.map((n) => n > 0);
  if (p[12] && p[0] && p[1] && p[2] && p[3]) return true; // A-2-3-4-5
  for (let i = 0; i + 4 < 13; i++) {
    if (p[i] && p[i + 1] && p[i + 2] && p[i + 3] && p[i + 4]) return true;
  }
  return false;
}

function straightOuts(rankCount: number[], boardLength: number): number {
  if (boardLength >= 5) return 0;
  let outs = 0;
  for (let r = 0; r < 13; r++) {
    if (rankCount[r]! > 0) continue; // the rank is already held
    const trial = rankCount.slice();
    trial[r] = trial[r]! + 1;
    if (hasStraight(trial)) outs++;
  }
  return outs;
}

/**
 * Hand strength via the shared evaluator; draw flags are a separate, clearly
 * heuristic layer (used only to pick bluff candidates, never to compare hands).
 */
export function evaluateHand(hole: readonly CardId[], board: readonly CardId[]): HandEval {
  const cards = [...hole, ...board];
  const rankCount = new Array<number>(13).fill(0);
  const suitCount = new Array<number>(4).fill(0);
  for (const card of cards) {
    rankCount[rankOf(card)] = rankCount[rankOf(card)]! + 1;
    suitCount[suitOf(card)] = suitCount[suitOf(card)]! + 1;
  }

  const score = bestScore(cards);
  const category = handCategory(score);

  const maxBoardRank = board.length ? Math.max(...board.map(rankOf)) : -1;
  const overcards = hole.filter((c) => rankOf(c) > maxBoardRank).length;
  const outs = straightOuts(rankCount, board.length);
  // A flush draw needs four to a suit *and* at least one of them in our hand.
  const flushDraw =
    board.length < 5 &&
    suitCount.some((n, s) => n === 4 && hole.some((c) => suitOf(c) === s));

  return {
    category,
    score,
    flushDraw,
    straightDraw: outs >= 2 ? 2 : outs === 1 ? 1 : 0,
    overcards,
  };
}

// ---------------------------------------------------------------------------
// board texture
// ---------------------------------------------------------------------------

export interface BoardTexture {
  maxSuit: number;
  /** Flush draw / made-flush heavy (>= 3 of a suit on the board). */
  suited: boolean;
  connected: boolean;
  paired: boolean;
  aceHigh: boolean;
  highCard: number;
  /** Connected and low — favours the caller's range. */
  lowConnected: boolean;
  wet: boolean;
}

export function classifyTexture(board: readonly CardId[]): BoardTexture {
  const suitCount = [0, 0, 0, 0];
  const seen = new Set<number>();
  let maxRank = -1;
  let minRank = 99;
  for (const card of board) {
    suitCount[suitOf(card)] = suitCount[suitOf(card)]! + 1;
    const r = rankOf(card);
    seen.add(r);
    if (r > maxRank) maxRank = r;
    if (r < minRank) minRank = r;
  }
  const ranks = [...seen].sort((a, b) => a - b);
  let adjacent = 0;
  for (let i = 1; i < ranks.length; i++) if (ranks[i]! - ranks[i - 1]! === 1) adjacent++;
  const maxSuit = Math.max(0, ...suitCount);
  const paired = seen.size < board.length;
  const suited = maxSuit >= 3;
  const connected = adjacent >= 2 || (board.length >= 3 && maxRank - minRank <= 4 && adjacent >= 1);
  const aceHigh = maxRank === 12;
  return {
    maxSuit,
    suited,
    connected,
    paired,
    aceHigh,
    highCard: maxRank,
    lowConnected: connected && maxRank <= 9,
    wet: suited || connected,
  };
}

// ---------------------------------------------------------------------------
// P1: flush stratification (nut / second / middle / low)
// ---------------------------------------------------------------------------

/** Suit/flush tier of a five-card flush for range weighting. */
export type FlushLayer = 'nut' | 'second' | 'middle' | 'low';

interface BoardFlushInfo {
  /** The board's dominant suit (the only suit with `count >= 3`). */
  suit: number;
  /** Number of board cards of that suit (>= 3). */
  count: number;
  /** The board's ranks of that suit, descending. */
  ranks: number[];
}

/** Board's dominant suit when it reaches three cards, else `null`. */
function boardFlushInfo(board: readonly CardId[]): BoardFlushInfo | null {
  const suitCount = [0, 0, 0, 0];
  const ranksBySuit: number[][] = [[], [], [], []];
  for (const card of board) {
    const s = suitOf(card);
    suitCount[s] = suitCount[s]! + 1;
    ranksBySuit[s]!.push(rankOf(card));
  }
  let suit = -1;
  let count = 0;
  for (let s = 0; s < 4; s++) {
    if (suitCount[s]! > count) {
      count = suitCount[s]!;
      suit = s;
    }
  }
  if (count < 3) return null;
  ranksBySuit[suit]!.sort((a, b) => b - a);
  return { suit, count, ranks: ranksBySuit[suit]! };
}

/** The suit a flush would be made in, or `null` when the board is not suited. */
export function dominantFlushSuit(board: readonly CardId[]): number | null {
  return boardFlushInfo(board)?.suit ?? null;
}

/**
 * Lexicographic strength key of a five-card flush: the five ranks sorted
 * descending, packed base-13 with the highest rank in the most-significant
 * position. Because every rank is in `[0, 12]` and the tuple length is fixed at
 * five, integer order equals the true lexicographic "highest card first, then
 * next, ..." flush order. A rank *sum* is NOT a valid flush key: on a
 * three-flush board the two completion cards reshape the whole tuple, so e.g.
 * `A Q 9 4 2` (A-high) is stronger than `K Q J 9 4` (K-high) despite a lower
 * rank sum.
 */
function flushStrengthKey(ranksDesc: readonly number[]): number {
  let key = 0;
  for (let i = 0; i < 5; i++) key = key * 13 + (ranksDesc[i] ?? 0);
  return key;
}

/**
 * Lexicographically sorted strength keys of every distinct five-card flush the
 * board allows, as a board-keyed cache. For a three-flush board that is C(10,2)
 * two-card completions; for a four-flush board the nine one-card completions; a
 * five-flush board has a single key.
 */
const flushDistCache = new Map<string, number[]>();

function flushKeyDistribution(board: readonly CardId[], info: BoardFlushInfo): number[] {
  const key = [...board].sort((a, b) => a - b).join(',');
  const cached = lruGet(flushDistCache, key);
  if (cached) return cached;
  const boardRanks = new Set(info.ranks);
  const remaining: number[] = [];
  for (let r = 0; r < 13; r++) if (!boardRanks.has(r)) remaining.push(r);
  const need = Math.max(0, 5 - info.count);
  const keys: number[] = [];
  const push = (extra: number[]) => {
    const merged = [...info.ranks, ...extra].sort((a, b) => b - a);
    keys.push(flushStrengthKey(merged));
  };
  if (need === 0) {
    push([]);
  } else if (need === 1) {
    for (const r of remaining) push([r]);
  } else if (need === 2) {
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) push([remaining[i]!, remaining[j]!]);
    }
  }
  keys.sort((a, b) => a - b);
  lruSet(flushDistCache, key, keys);
  return keys;
}

/**
 * Layer a made flush by the strength of its five cards relative to every flush
 * the board still allows: no stronger flush possible is the nuts, exactly one is
 * second, the upper half of the remaining distribution is middle, and the lower
 * half is a low flush. Strength is compared **lexicographically** (see
 * `flushStrengthKey`), never by rank sum. `hole` may be hero's or a villain
 * combo's; `null` when those held cards cannot make a flush on this board.
 */
export function flushLayerOf(hole: readonly CardId[], board: readonly CardId[]): FlushLayer | null {
  const info = boardFlushInfo(board);
  if (!info) return null;
  const handRanks = hole.filter((c) => suitOf(c) === info.suit).map(rankOf);
  const need = Math.max(0, 5 - info.count);
  if (handRanks.length < need) return null;
  const union = [...info.ranks, ...handRanks].sort((a, b) => b - a).slice(0, 5);
  if (union.length < 5) return null;
  const flushKey = flushStrengthKey(union);
  const dist = flushKeyDistribution(board, info);
  if (dist.length === 0) return null;
  // Number of board-possible flushes strictly stronger than this one.
  let lo = 0;
  let hi = dist.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid]! <= flushKey) lo = mid + 1;
    else hi = mid;
  }
  const stronger = dist.length - lo;
  if (stronger === 0) return 'nut';
  if (stronger === 1) return 'second';
  if (stronger * 2 < dist.length) return 'middle';
  return 'low';
}

/** Tier value of each flush layer used by `villainStrengthTier`. */
const FLUSH_TIER: Record<FlushLayer, number> = {
  nut: 1,
  second: 0.97,
  middle: 0.93,
  low: 0.88,
};

/**
 * True when the board offers a flush (>= 3 of a suit) and hero holds **no** card
 * of that suit - the "no-suit-protection" overpair spot. Such hands are a bluff
 * target against a flush-heavy value range, so their aggression is dialled down.
 */
export function heroFlushExposed(hole: readonly CardId[], board: readonly CardId[]): boolean {
  const info = boardFlushInfo(board);
  if (!info) return false;
  return !hole.some((card) => suitOf(card) === info.suit);
}

/**
 * True when hero holds a pocket pair strictly above every board card (an
 * overpair): both hole cards share a rank that is absent from the board, and
 * that rank is higher than the board's highest rank. A pocket pair at or below
 * the board is an underpair, and a pocket pair matching the board is a set /
 * trips - neither is an overpair. Pure and side-effect free.
 *
 * `ev`, when supplied, only short-circuits on the hand category (an overpair is
 * always a one-pair hand); callers that already evaluated the hand pass it to
 * avoid a second classification.
 */
export function isOverpair(
  hole: readonly CardId[],
  board: readonly CardId[],
  ev?: HandEval,
): boolean {
  if (hole.length !== 2 || board.length < 3) return false;
  if (ev && ev.category !== 1) return false;
  const pairRank = rankOf(hole[0]!);
  if (pairRank !== rankOf(hole[1]!)) return false;
  let maxBoard = -1;
  for (const card of board) {
    const boardRank = rankOf(card);
    if (boardRank === pairRank) return false; // set / trips, not an overpair
    if (boardRank > maxBoard) maxBoard = boardRank;
  }
  return pairRank > maxBoard;
}

/**
 * Multiplier applied to every villain **flush** combo before sampling, from
 * hero's own same-suit holding. Holding the nut blocker removes the opponent's
 * nut flushes (already excluded) and further discounts the flush range, raising
 * hero equity; holding no card of the suit leaves the flush range relatively
 * heavier, discounting hero's unprotected made hands.
 */
function heroFlushBlockFactor(hole: readonly CardId[], info: BoardFlushInfo): number {
  const handRanks = hole.filter((c) => suitOf(c) === info.suit).map(rankOf);
  if (handRanks.length === 0) return 1.12; // no protection: flush range heavier
  const used = new Set<number>([...info.ranks, ...handRanks]);
  let heroHigh = -1;
  for (const r of handRanks) if (r > heroHigh) heroHigh = r;
  let higher = 0;
  for (let r = heroHigh + 1; r < 13; r++) if (!used.has(r)) higher++;
  if (higher === 0) return 0.75; // nut blocker
  if (higher === 1) return 0.9; // second-nut blocker
  return 1;
}

// ---------------------------------------------------------------------------
// MDF / sizing / bluff ratio / blockers
// ---------------------------------------------------------------------------

/** Minimum defence frequency `P/(P+B)`, in [0, 1]. */
export function mdf(potBeforeBet: number, bet: number): number {
  if (!Number.isFinite(bet) || bet <= 0) return 1;
  const p = Math.max(0, Number.isFinite(potBeforeBet) ? potBeforeBet : 0);
  return p / (p + bet);
}

/** Equilibrium bluffs per value hand for a bet of `fraction` pot: `f/(1+f)`. */
export function bluffToValueRatio(fraction: number): number {
  const f = Math.max(0, Number.isFinite(fraction) ? fraction : 0);
  return f / (1 + f);
}

/** Probability a value hand fires, from the style's value-bet scale. */
export function valueBetProbability(params: RuleParams, advantage: number): number {
  return clamp01(0.55 + 0.4 * params.valueBetScale + 0.15 * advantage);
}

/** Blocker multiplier in [0.2, 2.2], centred near 1 for a neutral blocker. */
export function blockerFactor(blocker: number): number {
  return clamp(0.4 + 1.6 * clamp01(blocker), 0.2, 2.2);
}

/**
 * Approximate MDF defence probability for a bet requiring `requiredMdf`.
 *
 * A linear ramp of half-width `band` centred on `1 - requiredMdf`. The band is
 * clamped to the distance to either edge (`min(band, threshold, 1-threshold)`),
 * so integrating over a uniform percentile yields exactly `requiredMdf` even at
 * the boundaries (`requiredMdf = 0` defends nothing, `= 1` defends everything)
 * while remaining a seeded mix rather than a hard cutoff. This models *our*
 * range under a uniform unknown-combo prior, not the opponent's actual betting
 * range — it is an approximation, not an equilibrium solution.
 */
export function defendProbability(percentile: number, requiredMdf: number, band = 0.06): number {
  const required = clamp01(requiredMdf);
  const threshold = 1 - required;
  const effectiveBand = Math.min(band, threshold, 1 - threshold);
  if (effectiveBand <= 0) return percentile >= threshold ? 1 : 0;
  return clamp01((percentile - (threshold - effectiveBand)) / (2 * effectiveBand));
}

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

/**
 * Heuristic blocker score in [0, 1]: higher when our cards plausibly block the
 * opponent's continuing / nut range, lower when they block the hands they would
 * fold. A hand-built approximation (not a range-vs-range equity computation),
 * using only our hole cards and the public board.
 */
export function blockerScore(hole: readonly CardId[], board: readonly CardId[]): number {
  if (hole.length < 2 || board.length < 3) return 0;
  const boardRanks = board.map(rankOf);
  const minBoardRank = Math.min(...boardRanks);
  const maxBoardRank = Math.max(...boardRanks);
  const suitCount = [0, 0, 0, 0];
  for (const card of board) suitCount[suitOf(card)] = suitCount[suitOf(card)]! + 1;

  let score = 0;
  for (const card of hole) {
    const r = rankOf(card);
    const s = suitOf(card);
    if (r === 12) score += 0.45; // ace blocks the nuts
    else if (r === 11) score += 0.3; // king
    if (suitCount[s]! >= 2) score += 0.25; // blocks flush draws
    if (r >= minBoardRank - 1 && r <= maxBoardRank + 1) score += 0.15; // blocks straights
    if (r <= 4 && !boardRanks.includes(r)) score -= 0.2; // low junk = their folds
  }
  return clamp01(score / 1.5);
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
 * Pick one of `33% / 50% / 75% / 125% (overbet)`.
 *
 *  - wet boards: 75% (50% at low SPR, to avoid bloating with marginal equity);
 *  - dry ace-high / range-advantage boards: 33% range bet;
 *  - dry disadvantaged spots: 50%;
 *  - overbet only on dry, high-SPR, clear-advantage boards and within the
 *    style's `maxOverbetFrequency`.
 */
export function chooseBetFraction(texture: BoardTexture, ctx: SizingContext): number {
  const overbetFreq = ctx.maxOverbetFrequency ?? 0;
  if (
    !texture.wet &&
    ctx.rangeAdvantage >= 0.4 &&
    ctx.spr >= 4 &&
    overbetFreq > 0 &&
    (ctx.overbetRoll ?? 1) < overbetFreq
  ) {
    return 1.25;
  }
  if (texture.wet) return ctx.spr < 2.5 ? 0.5 : 0.75;
  if (ctx.rangeAdvantage >= 0.3) return 0.33;
  if (ctx.rangeAdvantage <= -0.3) return 0.5;
  return texture.aceHigh ? 0.33 : 0.5;
}

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
 * This is intentionally a small, explainable approximation: it does NOT do
 * range propagation (that is the P2 follow-on). The weighted range is applied to
 * every still-active opponent (a multiway simplification); when a tiny range
 * cannot fill every opponent without replacement, `estimateEquity` fills the
 * overflow uniformly and reports `uniformFallbacks`.
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

/** Tolerance for mirrored pot-odds fields (chips are integers; allows FP round-off). */
const PRICE_EPSILON = 1e-6;

export interface FacingBetPrice {
  /** True only when the snapshot is internally consistent and matches the legal call. */
  trusted: boolean;
  /** Pot before the bet (`pot - call`), or 0 when the pot is unusable. */
  potBefore: number;
  /** Authoritative `call / (pot + call)` recomputed from pot/call (0 when unusable). */
  derivedOdds: number;
  /** Price compared against equity: the mirrored odds when trusted, else derived. */
  requiredEquity: number;
  /** MDF `P/(P+B)` for the real price; a neutral 0.5 when the pot is unusable. */
  requiredMdf: number;
}

/**
 * Validate a facing-bet price snapshot against the legal call amount and the
 * authoritative `call / (pot + call)`, returning everything the decision needs.
 *
 * `trusted` requires ALL of:
 *  - a finite legal `call >= 0`;
 *  - `potOdds.pot` finite, `>= 0`, and `>= call` (a pot smaller than the call is
 *    malformed; it is NOT silently corrected with `max(0, pot - call)`);
 *  - `potOdds.callAmount` finite, `>= 0`, and exactly the legal call amount;
 *  - `potOdds.potOdds` finite in `[0, 1]` and within `1e-6` of the derived odds;
 *  - `potOdds.breakEvenEquity` finite in `[0, 1]` and within `1e-6` of the
 *    derived odds (the `DecisionPotOdds` contract makes it equal to `potOdds`).
 *
 * Any violation marks the snapshot untrusted; the caller then takes a
 * conservative neutral path rather than trusting (or clamping) the bad price.
 */
export function resolveFacingBetPrice(
  potOdds: DecisionPotOdds | null | undefined,
  legalCallAmount: number,
): FacingBetPrice {
  const call = legalCallAmount;
  const callValid = Number.isFinite(call) && call >= 0;
  const potValue = potOdds?.pot;
  const mirrorCall = potOdds?.callAmount;
  const potUsable =
    callValid &&
    typeof potValue === 'number' &&
    Number.isFinite(potValue) &&
    potValue >= 0 &&
    potValue >= call;
  const mirrorCallValid =
    typeof mirrorCall === 'number' &&
    Number.isFinite(mirrorCall) &&
    mirrorCall >= 0 &&
    mirrorCall === call;
  const potBefore = potUsable ? (potValue as number) - call : 0;
  const denominator = potBefore + 2 * call;
  const derivedOdds = potUsable && denominator > 0 ? call / denominator : 0;
  const oddsField = potOdds?.potOdds;
  const breakEvenField = potOdds?.breakEvenEquity;
  const oddsValid =
    typeof oddsField === 'number' &&
    Number.isFinite(oddsField) &&
    oddsField >= 0 &&
    oddsField <= 1 &&
    Math.abs(oddsField - derivedOdds) <= PRICE_EPSILON;
  const breakEvenValid =
    typeof breakEvenField === 'number' &&
    Number.isFinite(breakEvenField) &&
    breakEvenField >= 0 &&
    breakEvenField <= 1 &&
    Math.abs(breakEvenField - derivedOdds) <= PRICE_EPSILON &&
    // `DecisionPotOdds` contract: breakEvenEquity === potOdds (exact).
    typeof oddsField === 'number' &&
    breakEvenField === oddsField;
  const trusted = potUsable && mirrorCallValid && oddsValid && breakEvenValid;
  return {
    trusted,
    potBefore,
    derivedOdds,
    requiredEquity: trusted ? (oddsField as number) : derivedOdds,
    requiredMdf: potUsable ? mdf(potBefore, call) : 0.5,
  };
}

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
export function chooseVillainModel(input: VillainModelInput): VillainRangeModel {
  let score = 0;
  if (input.allIn) score += 2;
  else if (input.betFraction >= 1) score += 1.5;
  else if (input.betFraction <= 0.4) score -= 1;
  else if (input.betFraction <= 0.6) score -= 0.3;
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
  if (ev.category >= 6) return 1; // full house / quads / straight flush
  if (ev.category === 5) {
    // P1 flush stratification: nut 1.0, second .97, middle .93, low .88.
    return FLUSH_TIER[flushLayerOf(hole, board) ?? 'low'];
  }
  // On a four-flush board every non-flush made hand loses to any flush, so it
  // cannot be part of a value-heavy continuing range.
  const boardSuits = [0, 0, 0, 0];
  for (const card of board) boardSuits[suitOf(card)] = boardSuits[suitOf(card)]! + 1;
  if (Math.max(0, ...boardSuits) >= 4) return 0.35;
  if (ev.category === 4) return 0.95; // straight
  if (ev.category === 3) return 0.9; // three of a kind / set
  if (ev.category === 2) return 0.8; // two pair
  if (ev.category === 1) {
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
        isFlush: ev.category === 5,
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
    out.push({ cards: [combo.a, combo.b], weight });
  }
  return out;
}

/** Observed average VPIP / PFR / postflop aggression of the active opponents. */
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
    if (!stats || stats.sampleHands < 10) continue;
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
 * The coarse range model the P0 decision assigns to the current bettor, derived
 * only from the public `DecisionView`. Exported so tests can reproduce the
 * decision's own equity estimate exactly.
 */
export function facingVillainModel(
  view: DecisionView,
  potBefore: number,
  call: number,
): VillainRangeModel {
  const board = view.hand?.board ?? [];
  const texture = classifyTexture(board);
  const activeOpponents = view.opponents.filter((o) => !o.folded);
  const stats = opponentModelStats(view);
  return chooseVillainModel({
    betFraction: potBefore > 0 ? call / potBefore : 1,
    allIn: activeOpponents.some((o) => o.allIn),
    heroWasAggressor: heroWasAggressor(view),
    wet: texture.wet,
    opponentVpip: stats.vpip,
    opponentPfr: stats.pfr,
    opponentAggression: stats.aggression,
  });
}

/** Weighted range the P0 decision samples against for this view. */
export function facingVillainRange(
  view: DecisionView,
  hole: readonly CardId[],
  potBefore: number,
  call: number,
): VillainRange {
  const board = view.hand?.board ?? [];
  return { combos: buildVillainRange(hole, board, facingVillainModel(view, potBefore, call)) };
}

// ---------------------------------------------------------------------------
// positional / aggression helpers
// ---------------------------------------------------------------------------

export function heroWasAggressor(view: DecisionView): boolean {
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  if (mySeat === null) return false;
  const pre = view.actionHistory.filter((a) => a.street === 'preflop');
  for (let i = pre.length - 1; i >= 0; i--) {
    const a = pre[i]!;
    if (a.action.type === 'bet' || a.action.type === 'raise') return a.seat === mySeat;
  }
  return false;
}

/** True when hero is the last active seat to act postflop (i.e. on the button). */
export function heroInPosition(view: DecisionView): boolean {
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  if (mySeat === null) return false;
  const order = seatsInDealingOrder(view);
  if (order.length === 0) return false;
  const active = order.filter(
    (seat) => seat === mySeat || view.opponents.some((o) => o.seat === seat && !o.folded),
  );
  return active.length > 0 && active[active.length - 1] === mySeat;
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

function normalizeLegal(la: DecisionLegalActions): DecisionLegalActions {
  const canCall = la.canCall && la.callAmount > 0;
  const canCheck = la.canCheck || !canCall;
  const canRaise =
    (la.canBet || la.canRaise) &&
    la.minRaiseTo >= 1 &&
    la.maxRaiseTo >= la.minRaiseTo &&
    la.maxRaiseTo > 0;
  return { ...la, canCheck, canCall, canRaise, canBet: canRaise && la.canBet };
}

export interface PostflopOptions {
  params: RuleParams;
  /** Base seed; the per-decision seed is `deriveRulesSeed(seed, view)`. */
  seed?: number;
}

/** A legitimate, always-legal fallback action. */
function onlyLegal(la: DecisionLegalActions, reason: string): PolicyDecision {
  if (la.canCheck) return { action: { type: 'check' }, reason };
  if (la.canCall) return { action: { type: 'call' }, reason };
  return { action: { type: 'fold' }, reason };
}

export class BaselinePostflopPolicy {
  readonly name = 'rules-v1-postflop';
  private readonly params: RuleParams;
  private readonly seed: number;

  constructor(options: PostflopOptions) {
    this.params = options.params;
    this.seed = options.seed ?? 0x9e3779b9;
  }

  decide(view: DecisionView): PolicyDecision {
    const raw = view.legalActions;
    if (!raw) throw new Error(`${this.name} asked to act out of turn`);
    const la = normalizeLegal(raw);
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
    const pot = view.potOdds?.pot ?? 0;
    if (pot <= 0) return 10;
    const myStack = view.me?.stack ?? 0;
    const activeStacks = view.opponents
      .filter((o) => !o.folded && !o.allIn)
      .map((o) => o.stack);
    const oppMax = activeStacks.length ? Math.max(...activeStacks) : 0;
    const effective = oppMax > 0 ? Math.min(myStack, oppMax) : myStack;
    return effective / pot;
  }

  private effectiveStackBB(view: DecisionView): number {
    const bb = view.room?.bb && view.room.bb > 0 ? view.room.bb : 1;
    const myStack = view.me?.stack ?? 0;
    const activeStacks = view.opponents
      .filter((o) => !o.folded && !o.allIn)
      .map((o) => o.stack);
    const oppMax = activeStacks.length ? Math.max(...activeStacks) : 0;
    return (oppMax > 0 ? Math.min(myStack, oppMax) : myStack) / bb;
  }

  private exploitMultiplier(view: DecisionView): number {
    const bySeat = new Map(view.sessionMemory.opponents.map((o) => [o.seat, o]));
    let vpip = 0;
    let pfr = 0;
    let n = 0;
    for (const o of view.opponents) {
      if (o.folded) continue;
      const stats = bySeat.get(o.seat);
      if (!stats || stats.sampleHands < 10) continue;
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
    const value = ev.category >= 3 || percentile >= 0.8;
    const bluffCandidate = !value && percentile < 0.6 && (draw || blocker >= 0.4);
    // P1: an **overpair** with no card of the board's flush suit is a
    // bluff-catcher against a flush-heavy continuing range, so it bets less
    // often. The discount is deliberately scoped to exposed overpairs only -
    // sets, two pair, straights and strong draws keep their normal frequency.
    const exposedOverpair = isOverpair(hole, board, ev) && heroFlushExposed(hole, board);

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
        const fraction = chooseBetFraction(texture, sizingCtx);
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
          villainRange: facingVillainRange(view, hole, potBefore, call),
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
    // equity gate and a lower raise frequency). Sets, two pair, straights and
    // strong draws are unaffected.
    const exposedOverpair = isOverpair(hole, board, ev) && heroFlushExposed(hole, board);
    const strong =
      ev.category >= 3 ||
      percentile >= 0.85 ||
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
    // Sub-20BB: an unopened bet is a deliberate shove to the stack, matching the
    // raise() convention (and the shared engine's "bet up to stack" rule).
    if (this.effectiveStackBB(view) < 20) {
      return { action: { type: 'bet', amount: la.maxRaiseTo }, reason: `${reason} all-in` };
    }
    const pot = view.potOdds?.pot ?? 0;
    const fraction = chooseBetFraction(texture, ctx);
    const raw = Math.round(pot * fraction);
    const amount = clamp(raw, la.minRaiseTo, la.maxRaiseTo);
    return { action: { type: 'bet', amount: Math.max(1, amount) }, reason };
  }

  private raise(
    view: DecisionView,
    la: DecisionLegalActions,
    texture: BoardTexture,
    ctx: SizingContext,
    reason: string,
  ): { action: { type: 'raise'; amount: number }; reason: string } {
    if (this.effectiveStackBB(view) < 20) {
      return { action: { type: 'raise', amount: la.maxRaiseTo }, reason: `${reason} all-in` };
    }
    const pot = view.potOdds?.pot ?? 0;
    const currentBet = view.hand?.currentBet ?? 0;
    const fraction = chooseBetFraction(texture, ctx);
    const minDelta = Math.max(1, la.minRaiseTo - currentBet);
    const target = currentBet + Math.max(minDelta, Math.round(pot * fraction));
    const amount = clamp(target, la.minRaiseTo, la.maxRaiseTo);
    return { action: { type: 'raise', amount }, reason };
  }
}
