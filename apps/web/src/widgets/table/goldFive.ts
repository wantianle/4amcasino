import { HAND_CATEGORY, bestFive, evaluate7, handCategory, type CardId } from '@4am/shared';

/** The cards that MAKE this seat's hand, once the board is final (5 cards)
 *  and the category reaches two pair or better. Returns the exact subset of
 *  hole + board that composes the best five — the gold frame must ride only
 *  these, never all seven (restraint rule: no full-table effects).
 *  Null while the board is incomplete or the hand is under threshold.
 *
 *  The threshold uses the named `HAND_CATEGORY.twoPair` instead of a bare `2`:
 *  `2` is the category number packed into `@4am/shared`'s score (bits 20-31),
 *  a cross-package contract frozen by `packages/shared/test/scoreLayout.test.ts`
 *  and now pinned by `packages/shared/test/handCategoryConstants.test.ts`. It is
 *  deliberately NOT `HAND_CATEGORY_NAMES.indexOf('Two Pair')` — a rename,
 *  localisation, or spelling change would make `indexOf` return -1 and
 *  `handCategory(...) < -1` is never true, so the bar would fall to "every hand
 *  glows" instead of "none glow". */
export function goldFive(hole: CardId[] | undefined, board: CardId[]): Set<CardId> | null {
  if (!hole || hole.length < 2 || board.length !== 5) return null;
  const seven = [...hole, ...board];
  if (handCategory(evaluate7(seven)) < HAND_CATEGORY.twoPair) return null;
  return new Set(bestFive(seven));
}
