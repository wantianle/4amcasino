import {
  HAND_CATEGORY,
  evaluate5,
  evaluate7,
  handCategory,
  rankOf,
  suitOf,
  type CardId,
} from '@4am/shared';

/**
 * Postflop hand strength / evaluation (pure feature layer).
 *
 * Moved verbatim out of `postflopPolicy.ts`. Hand ranking is delegated entirely
 * to the shared evaluator (`evaluate5`/`evaluate7`); the draw flags are a
 * separate, clearly heuristic layer used only to pick bluff candidates, never to
 * compare hands.
 */

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
  /**
   * Straight-draw *heuristic*: 0 none, 1 gutshot, 2 open-ended / double-gutter.
   * A completion counts only when it uses a rank hero **uniquely supplies**
   * (neither already on the board nor the completing card itself), and this is
   * always 0 once hero already has a straight or better (see `evaluateHand`).
   * It is not an exact outs count.
   */
  straightDraw: number;
  overcards: number;
}

/** Best 5-card score from 5..7 cards, using the shared evaluators. */
export function bestScore(cards: readonly CardId[]): number {
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

/**
 * The five-rank windows (wheel included) that constitute a straight. Kept as
 * explicit rank lists so `straightOuts` can ask not only *whether* a straight
 * exists but *which ranks* it uses.
 */
export const STRAIGHT_WINDOWS: readonly (readonly number[])[] = (() => {
  const windows: number[][] = [[12, 0, 1, 2, 3]]; // A-2-3-4-5 wheel
  for (let i = 0; i + 4 < 13; i++) windows.push([i, i + 1, i + 2, i + 3, i + 4]);
  return windows;
})();

/**
 * Straight outs that hero actually contributes to.
 *
 * A completing rank counts only when at least one straight it makes uses a rank
 * that hero **uniquely supplies** - i.e. a rank that neither the board nor the
 * completing card already provides. This is a rank-*source* test, not a set
 * intersection:
 *
 *  - `9-8-7-6` on the board completed by `5` / `T` is a **board-only
 *    completion**; hero's hole cards take no part and it is not hero's draw.
 *  - `hole = As 2d` on `Ah Qc Jd Tc` completed by the board's `K`: the `A` rank
 *    is already on the board, so hero's `As` is not a unique contribution and
 *    the `A-K-Q-J-T` straight is board-only.
 *  - `hole = Th Jd` on `9-8-2` completed by `Q`: the window `8-9-T-J-Q` needs
 *    hero's `T`/`J` (neither on the board), so it DOES count.
 *
 * Because a held rank is skipped by the loop, the completing card can never be
 * a hero rank: `heroRankSet.has(rank) && !boardRankSet.has(rank)` is exactly
 * "only hero supplies this rank". Pure.
 */
function straightOuts(
  rankCount: number[],
  boardLength: number,
  heroRanks: readonly number[],
  boardRanks: readonly number[],
): number {
  if (boardLength >= 5) return 0;
  const heroRankSet = new Set(heroRanks);
  const boardRankSet = new Set(boardRanks);
  let outs = 0;
  for (let r = 0; r < 13; r++) {
    if (rankCount[r]! > 0) continue; // the rank is already held
    const trial = rankCount.slice();
    trial[r] = trial[r]! + 1;
    const present = trial.map((n) => n > 0);
    const usesHero = STRAIGHT_WINDOWS.some(
      (window) =>
        window.every((rank) => present[rank]) &&
        window.some((rank) => heroRankSet.has(rank) && !boardRankSet.has(rank)),
    );
    if (usesHero) outs++;
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

  const boardRanks = board.map(rankOf);
  const maxBoardRank = board.length ? Math.max(...boardRanks) : -1;
  const overcards = hole.filter((c) => rankOf(c) > maxBoardRank).length;
  const outs = straightOuts(rankCount, board.length, hole.map(rankOf), boardRanks);
  // A flush draw needs four to a suit *and* at least one of them in our hand.
  const flushDraw =
    board.length < 5 &&
    suitCount.some((n, s) => n === 4 && hole.some((c) => suitOf(c) === s));
  // `straightDraw` means "not made yet, can still improve". Once the best five
  // cards already form a straight or better (category >= 4) there is nothing
  // left to draw to, so it is 0 by definition - consistent with `flushDraw`,
  // which is likewise only true for a four-card (unmade) suit.
  const straightDraw = category >= HAND_CATEGORY.straight ? 0 : outs >= 2 ? 2 : outs === 1 ? 1 : 0;

  return {
    category,
    score,
    flushDraw,
    straightDraw,
    overcards,
  };
}
