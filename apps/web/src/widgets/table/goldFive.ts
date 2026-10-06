import { bestFive, evaluate7, handCategory, type CardId } from '@4am/shared';

/** Made-hand threshold: Two Pair and above. `2` is a frozen contract of
 *  `@4am/shared`'s packed score — the category lives in bits 20-31 and its
 *  number is fixed (`evaluate.ts`; frozen by packages/shared
 *  test/scoreLayout.test.ts and already spelled `case 2:` in
 *  shared/i18n/pokerLabels.ts). It is deliberately NOT
 *  `HAND_CATEGORY_NAMES.indexOf('Two Pair')`: a rename, localisation, or
 *  spelling change would make `indexOf` return -1, and `handCategory(...) < -1`
 *  is never true — the bar would fall to "every hand glows" instead of "none
 *  glow". */
const TWO_PAIR = 2;

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
