import { ALL_CARDS, type CardId } from '@4am/shared';
import { bestScore } from './postflopStrength.js';
import { lruGet, lruSet } from './postflopCache.js';

/**
 * Hand percentile vs a uniform opponent prior (a postflop signal).
 *
 * Moved verbatim out of `postflopPolicy.ts`: an empirical CDF of hero's hand
 * against every board-remaining opponent combo (board + hero removed), cached
 * per board. Pure and decision-free; re-exported from `postflopPolicy.ts`.
 */

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
