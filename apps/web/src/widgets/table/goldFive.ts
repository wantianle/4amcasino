import { HAND_CATEGORY_NAMES, bestFive, evaluate7, handCategory, type CardId } from '@4am/shared';

/** Made-hand threshold: Two Pair and above (index into HAND_CATEGORY_NAMES —
 *  order-tolerant, the names are the contract, not the number). */
const TWO_PAIR = HAND_CATEGORY_NAMES.indexOf('Two Pair');

/** The cards that MAKE this seat's hand, once the board is final (5 cards)
 *  and the category reaches two pair or better. Returns the exact subset of
 *  hole + board that composes the best five — the gold frame must ride only
 *  these, never all seven (restraint rule: no full-table effects).
 *  Null while the board is incomplete or the hand is under threshold. */
export function goldFive(hole: CardId[] | undefined, board: CardId[]): Set<CardId> | null {
  if (!hole || hole.length < 2 || board.length !== 5) return null;
  const seven = [...hole, ...board];
  if (handCategory(evaluate7(seven)) < TWO_PAIR) return null;
  return new Set(bestFive(seven));
}
