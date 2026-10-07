import { HAND_CATEGORY, rankOf, suitOf, type CardId } from '@4am/shared';
import { bestScore, STRAIGHT_WINDOWS, type HandEval } from './postflopStrength.js';
import type { BoardTexture } from './postflopTexture.js';
import { lruGet, lruSet } from './postflopCache.js';
import { clamp01 } from './postflopMath.js';

/**
 * Flush stratification (P1) and blocker features (pure feature layer).
 *
 * Moved verbatim out of `postflopPolicy.ts`: the flush ladder
 * (nut / second / middle / low), the suit-exposure and overpair predicates, the
 * board-aware made-hand suppression used by the value leg, hero's flush-block
 * correction, and the hand-built `blockerScore`. None of these make a decision
 * or touch the policy state.
 */

/** Suit/flush tier of a five-card flush for range weighting. */
export type FlushLayer = 'nut' | 'second' | 'middle' | 'low';

export interface BoardFlushInfo {
  /** The board's dominant suit (the only suit with `count >= 3`). */
  suit: number;
  /** Number of board cards of that suit (>= 3). */
  count: number;
  /** The board's ranks of that suit, descending. */
  ranks: number[];
}

/** Board's dominant suit when it reaches three cards, else `null`. */
export function boardFlushInfo(board: readonly CardId[]): BoardFlushInfo | null {
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
export const FLUSH_TIER: Record<FlushLayer, number> = {
  nut: 1,
  second: 0.97,
  middle: 0.93,
  low: 0.88,
};

/**
 * **Suit-exposure predicate only**: true when the board offers a flush (>= 3 of
 * a suit) and hero holds **no** card of that suit. It says nothing about hand
 * strength - a set, a straight, air and an overpair are all "exposed" here. The
 * *decision* rule that dials aggression down applies only to an **exposed
 * overpair**, which is the explicit composition `isExposedOverpair` below, not
 * this predicate alone. Callers must never treat `heroFlushExposed` as "the
 * exposed-overpair spot".
 */
export function heroFlushExposed(hole: readonly CardId[], board: readonly CardId[]): boolean {
  const info = boardFlushInfo(board);
  if (!info) return false;
  return !hole.some((card) => suitOf(card) === info.suit);
}

/**
 * The exact hand the P1 no-suit discount is scoped to: an **overpair** (`ev`
 * category one pair, pair above the board) with no card of the board's flush
 * suit. This is the single explicit definition both the value-bet and value-
 * raise call sites use, so the "which hands are discounted" set cannot drift
 * apart or silently widen to every no-suit made hand.
 */
export function isExposedOverpair(
  hole: readonly CardId[],
  board: readonly CardId[],
  ev: HandEval,
): boolean {
  return isOverpair(hole, board, ev) && heroFlushExposed(hole, board);
}

/**
 * True when hero holds a pocket pair strictly above every board card (an
 * overpair): both hole cards share a rank that is absent from the board, and
 * that rank is higher than the board's highest rank. A pocket pair at or below
 * the board is an underpair, and a pocket pair matching the board is a set /
 * trips - neither is an overpair. Pure and side-effect free.
 *
 * `ev` is **required** and must be `evaluateHand(hole, board)`. The hand
 * category is what makes the predicate safe on a *paired* board: `AA` on `QQx`
 * is two pair (aces and queens), not an overpair, and only the evaluated
 * category (`!== 1`) rejects it. An earlier optional-`ev` signature silently
 * returned `true` for exactly that case, so the category check is now part of
 * the contract rather than a caller-supplied optimisation. Passing an `ev`
 * computed for a different hole/board is a programming error.
 */
export function isOverpair(
  hole: readonly CardId[],
  board: readonly CardId[],
  ev: HandEval,
): boolean {
  if (hole.length !== 2 || board.length < 3) return false;
  if (ev.category !== HAND_CATEGORY.pair) return false;
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
 * True when the board supplies at least four of the five ranks of some straight
 * (the wheel included), i.e. it is one rank away from completing a straight any
 * opponent holding that rank already has. Board-only by design: hero's hole
 * cards cannot remove the opponents' straights, and a hero who completes one is
 * `category >= 4` and is filtered by the caller before this matters. Pure.
 */
function boardOffersStraight(board: readonly CardId[]): boolean {
  const present = new Set(board.map(rankOf));
  for (const window of STRAIGHT_WINDOWS) {
    let count = 0;
    for (const rank of window) if (present.has(rank)) count++;
    if (count >= 4) return true;
  }
  return false;
}

/**
 * True when hero's best five-card hand is exactly the board's own best five, so
 * the "made hand" belongs to the board and is shared by every player rather than
 * produced by hero's hole cards. Only possible on a complete (five-card) board:
 * on the turn the best five of six cards must use at least one hole card.
 *
 * The test is the shared evaluator's exact score equality, so a hole card that
 * merely ties the board's best five (without improving it) still counts as no
 * contribution - which is the intended semantics: a hand hero cannot improve on
 * is not hero's value. Pure.
 */
function boardOnlyMadeHand(board: readonly CardId[], ev: HandEval): boolean {
  return board.length >= 5 && bestScore(board) === ev.score;
}

/**
 * Board-aware made-hand suppression for the **value** leg (both the facing-bet
 * value raise and the unopened value bet): true when the made hand's raw
 * category is a product of the board rather than a hand that is actually ahead
 * of the range that continues.
 *
 * `decideFacingBet` / `decideUnopened` historically read `category >= 3` (or a
 * flush and better) as absolute strength, so a set / trips - and, worse, a
 * board-only flush, boat, quads or straight flush - kept value raising even
 * where every opponent continue beats it. This predicate marks those spots so
 * the caller falls back to the real equity edge / normal flow instead of the
 * category / percentile proxies:
 *
 *  - **Board-only made hand of value category** (`category >= 3` and
 *    `boardOnlyMadeHand`): a trips / straight / flush / full house / quads /
 *    straight flush whose best five are the board's own best five is shared by
 *    every player, not hero's value. This is exactly the set the value leg
 *    treats as value (`category >= 3`), so it is the set that must be nullified:
 *    the pre-fix `category >= 5` enumeration missed a board-only **straight**
 *    (`As Kd` on `5c 6d 7h 8s 9c`, `category === 4`) and a board-only **trips**
 *    (e.g. `8d 4d` on `7h 7d 7c Ks 9s`, `category === 3`), both of which kept
 *    value betting / raising. A straight flush on a five-flush board is covered
 *    here too (`category === 8`). A boat / quads / flush / straight / trips that
 *    hero actually improves (e.g. `Js 7d` on `Jc 7c 4c 2c Jd`) is *not*
 *    board-only and stays a value hand. A board-only hand of `category <= 2`
 *    (pair / two pair / high card) is deliberately NOT flagged here: it can
 *    never satisfy the `category >= 3` value test and its percentile tops out
 *    far below the `0.8 / 0.85` value gates, so it is never value in the first
 *    place (see `boardOnlyMadeHand` and the `weak board-only` tests).
 *  - **Four-flush board, hero holds no card of the suit** (`texture.maxSuit >= 4`
 *    and `heroFlushExposed`) for a hand worse than a full house (`category < 6`):
 *    every such made hand - a board-only flush (`category === 5`, only reachable
 *    when the whole board is one suit), a straight, set/trips, two pair,
 *    pair/overpair - loses to the flush any opponent holding the suit can make,
 *    so it is not an automatic value raise. A full house or better that hero
 *    contributes beats the flush and is deliberately excluded. Holding a suit
 *    card (a blocker) lifts the suppression, so the decision returns to the
 *    normal category / percentile / equity test rather than being uniformly
 *    downgraded (consistent with the P1 `heroFlushExposed` overpair discount).
 *  - **Four-to-a-straight board, hero does not already have the straight**
 *    (`boardOffersStraight` and `category < 4`): a non-straight made hand loses
 *    to the straight the board completes and is not an automatic value raise. A
 *    hero holding a completing rank has `category >= 4` and is never suppressed.
 *
 * This is deliberately a board-strength correction scoped to the value leg. It
 * says nothing about the call/fold (defend) equity, which is computed separately
 * and left untouched. It is intentionally not `isExposedOverpair`, whose
 * overpair-only semantics remain the P1 no-suit discount. Pure and side-effect
 * free.
 */
export function madeHandSuppressedByBoard(
  hole: readonly CardId[],
  board: readonly CardId[],
  ev: HandEval,
  texture: BoardTexture,
): boolean {
  // Board-only made hand of value category (`>= 3`): trips / straight / flush /
  // boat / quads / straight flush whose best five are the board's own best
  // five, shared by every player, not hero's value. This is exactly the set the
  // value leg treats as value, so it is the set that must be nullified.
  if (ev.category >= HAND_CATEGORY.trips && boardOnlyMadeHand(board, ev)) return true;
  // Four-flush board, no suit card, hand worse than a full house: any flush
  // beats it. `category === 5` here is a board-only flush (the whole board is
  // one suit and hero holds none of it); a hero-contributed flush has a suit
  // card and so is not `heroFlushExposed`.
  if (
    texture.maxSuit >= 4 &&
    heroFlushExposed(hole, board) &&
    ev.category < HAND_CATEGORY.fullHouse
  )
    return true;
  // Four-to-a-straight board, hero does not already have the straight.
  if (ev.category < HAND_CATEGORY.straight && boardOffersStraight(board)) return true;
  return false;
}

/**
 * Multiplier applied to every villain **flush** combo before sampling, from
 * hero's own same-suit holding. Holding the nut blocker removes the opponent's
 * nut flushes (already excluded) and further discounts the flush range, raising
 * hero equity; holding no card of the suit leaves the flush range relatively
 * heavier, discounting hero's unprotected made hands.
 */
export function heroFlushBlockFactor(hole: readonly CardId[], info: BoardFlushInfo): number {
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
